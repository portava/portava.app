/**
 * memoryPlaceSplitReresolution.test.ts — census-highlights-memories H72, §9
 * "Entity splits trigger re-resolution from retained evidence" (B58 cluster
 * MEM-PLACE-SPLIT; migration 3812).
 *
 * Drives the REAL router (routes/memoryPlaceSplit.ts) over HTTP with a
 * table-backed fake that records every read and write. The fake ports 3812's
 * SQL — place_split, the proposals guard, the evidence CHECKs and the
 * (memory_id, split_id) uniqueness — so the API can be driven end to end; the SQL
 * itself is executed by src/test/db/memoryPlaceSplitReresolution.db.test.ts
 * (CI's local-db job) and sql/rehearsals/3812_01_place_split_reresolution.sql.
 *
 *   S  split P into P1 (= P, kept) and P2: a Memory at P1's coordinates whose
 *      occurrence name is P1's gets a proposal suggesting P1; one at P2's
 *      coordinates and name suggests P2
 *   U  unresolved, never a guess: equidistant (both within 75 m, or neither),
 *      a name that does not match, no coordinates, no occurrence name, a
 *      non-Latin name that normalizes to nothing
 *   C  a Memory with any owner place correction gets NO proposal; an
 *      unreadable corrections read gets none either
 *   W  the job never writes `memories` or `memory_corrections` (every write is
 *      spied); it is idempotent; a deleted, removed or elsewhere Memory is not
 *      read as the split place's
 *   F  flags OFF / absent: the split is refused with nothing written and the job
 *      is inert (nothing read past the flags); unreadable is 503; the owner's
 *      routes fall through as if the router were not mounted
 *   O  the owner reads only their own pending proposals, without coordinates;
 *      accept records a choice only once the Memory stores it (the place change
 *      is PATCH /memories/:id, H-10); dismiss; someone else's is a 404
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx/esm --test src/test/memoryPlaceSplitReresolution.test.ts
 */
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { randomUUID } from "node:crypto";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import memoryPlaceSplitRouter from "../routes/memoryPlaceSplit.js";
import memoriesRouter from "../routes/memories.js";
import apiRouter from "../routes/index.js";
import {
  MEMORY_PLACE_SPLIT_FLAG,
  EXTERNAL_PLACES_FLAG,
  OCCURRENCE_NAME_FLAG,
  RERESOLUTION_BOUND_M,
  combineGates,
  decideProposal,
  distanceMeters,
  normalizedPlaceName,
  runSplitReresolution,
} from "../services/memory/memoryPlaceSplitReresolution.js";

// ── Geometry: P1 at (10, 106); P2 100 m east of it ───────────────────────────
const LAT = 10;
const LNG = 106;
const M_PER_DEG_LNG = 111_320 * Math.cos((LAT * Math.PI) / 180);
const M_PER_DEG_LAT = 110_574;
const east = (m: number) => LNG + m / M_PER_DEG_LNG;
const north = (m: number) => LAT + m / M_PER_DEG_LAT;

const ADMIN = "a7200000-0000-4000-8000-000000000001";
const A = "a7200000-0000-4000-8000-000000000002"; // owns most Memories
const B = "a7200000-0000-4000-8000-000000000003"; // owns one Memory at P
const P = "f7200000-0000-4000-8000-000000000001"; // "Cafe A", the row that turns out to be two venues
const ELSEWHERE = "f7200000-0000-4000-8000-000000000009";
const REF_A = "e7200000-0000-4000-8000-000000000001";
const REF_B = "e7200000-0000-4000-8000-000000000002";

const mid = (n: number) => `b7200000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const M_AT_P1 = mid(1); // at P1's coordinates, recorded as "Cafe A"
const M_AT_P2 = mid(2); // at P2's coordinates, recorded as "Bar B"
const M_EQUI = mid(3); // midway: 50 m from each
const M_EQUI_FAR = mid(4); // 150 m north of the midpoint: neither within 75 m
const M_NAME = mid(5); // at P1's coordinates, recorded as "Somewhere Else"
const M_CORRECTED = mid(6); // at P1's coordinates, but the owner corrected its place
const M_NOCOORD = mid(7); // no coordinates
const M_NONAME = mid(8); // at P1's coordinates, no occurrence name (legacy / 3804 absent)
const M_DELETED = mid(9); // deleted
const M_REMOVED = mid(10); // removed by a moderator
const M_ELSEWHERE = mid(11); // stores another place
const M_B = mid(12); // B's, at P1's coordinates

type FlagValue = boolean | "unreadable";
interface World {
  flags: Record<string, FlagValue>;
  failReads?: Set<string>;
  failWrites?: Set<string>;
}

const ON: Record<string, FlagValue> = { [MEMORY_PLACE_SPLIT_FLAG]: true, [EXTERNAL_PLACES_FLAG]: true, [OCCURRENCE_NAME_FLAG]: false };

function memory(id: string, owner: string, over: Record<string, unknown> = {}) {
  return { id, owner_id: owner, title: id, visibility: "only_me", state: "published", place_id: P, location_lat: String(LAT), location_lng: String(LNG), place_display_name_at_occurrence: "Cafe A", ...over };
}

function seed(w: World): Record<string, any[]> {
  return {
    feature_flags: Object.entries(w.flags).filter(([, v]) => v !== "unreadable").map(([flag, enabled]) => ({ flag, enabled })),
    profiles: [ADMIN, A, B].map((id, i) => ({ id, role: id === ADMIN ? "admin" : "user", account_status: "active", handle: `u${i}` })),
    places: [
      { id: P, name: "Cafe A", normalized_name: "cafe a", primary_category: "cafe", latitude: LAT, longitude: LNG, address: "1 Street", city: "Da Nang", neighborhood: null, country_code: "VN", canonical_location_id: null, status: "active", merged_into_place_id: null },
      { id: ELSEWHERE, name: "Elsewhere", normalized_name: "elsewhere", primary_category: "cafe", latitude: north(5000), longitude: LNG, status: "active", merged_into_place_id: null },
    ],
    external_place_references: [
      { id: REF_A, place_id: P, provider: "fsq", provider_place_id: "a" },
      { id: REF_B, place_id: P, provider: "fsq", provider_place_id: "b" },
    ],
    place_merge_log: [],
    memories: [
      memory(M_AT_P1, A),
      memory(M_AT_P2, A, { location_lng: String(east(100)), place_display_name_at_occurrence: "Bar B" }),
      memory(M_EQUI, A, { location_lng: String(east(50)) }),
      memory(M_EQUI_FAR, A, { location_lat: String(north(150)), location_lng: String(east(50)) }),
      memory(M_NAME, A, { place_display_name_at_occurrence: "Somewhere Else" }),
      memory(M_CORRECTED, A),
      memory(M_NOCOORD, A, { location_lat: null, location_lng: null }),
      memory(M_NONAME, A, { place_display_name_at_occurrence: null }),
      memory(M_DELETED, A, { state: "deleted" }),
      memory(M_REMOVED, A, { state: "removed" }),
      memory(M_ELSEWHERE, A, { place_id: ELSEWHERE }),
      memory(M_B, B),
    ],
    memory_corrections: [
      { id: "c7200000-0000-4000-8000-000000000001", memory_id: M_CORRECTED, owner_id: A, field: "place", kind: "reject", place_id: ELSEWHERE, canonical_location_id: null, created_at: "2026-10-01T00:00:00.000Z", source: "correction_route" },
    ],
    memory_place_reresolution_proposals: [],
  };
}

interface Op { table: string; mode: string; cols?: string; payload?: any; filters?: string }

const REASONS = ["unique_within_bound_name_match", "no_coordinates", "candidate_without_coordinates", "none_within_bound", "several_within_bound", "no_occurrence_name", "name_mismatch"];

/** 3812's CHECKs on a proposal, ported. */
function proposalChecks(r: any): string | null {
  const c: string[] = r.candidate_place_ids;
  if (!Array.isArray(c) || c.length < 2 || c.length > 10 || !c.includes(r.split_from_place_id) || c.some((x) => x == null)) return "candidates";
  if (r.suggested_place_id != null && !c.includes(r.suggested_place_id)) return "suggestion";
  const e = r.evidence;
  if (!e || typeof e !== "object" || Array.isArray(e)) return "evidence_shape";
  if (Object.keys(e).some((k) => !["rule", "bound_m", "reason", "candidates"].includes(k))) return "evidence_shape";
  if (typeof e.rule !== "string" || typeof e.bound_m !== "number" || !REASONS.includes(e.reason) || !Array.isArray(e.candidates)) return "evidence_shape";
  for (const x of e.candidates) {
    if (!x || typeof x !== "object" || Array.isArray(x)) return "evidence_shape";
    for (const [k, v] of Object.entries(x)) {
      if (!["place_id", "within_bound", "name_match"].includes(k)) return "evidence_shape";
      if (typeof v === "number" || (v !== null && typeof v === "object")) return "evidence_shape";
    }
  }
  if ((r.suggested_place_id != null) !== (e.reason === "unique_within_bound_name_match")) return "suggested_iff_resolved";
  if (!["pending", "accepted", "dismissed"].includes(r.state)) return "state";
  if ((r.state === "pending") !== (r.decided_at == null)) return "decided";
  if ((r.state === "accepted") !== (r.accepted_place_id != null) || (r.accepted_place_id != null && !c.includes(r.accepted_place_id))) return "accepted";
  return null;
}

/** 3812's memory_place_reresolution_proposals_guard, ported. */
function guard(store: Record<string, any[]>, prev: any | null, next: any): { code: string; message: string } | null {
  const refuse = (m: string, code = "23514") => ({ code, message: `memory_place_reresolution_proposals: ${m}` });
  if (!prev) {
    const m = store.memories.find((x) => x.id === next.memory_id);
    if (!m) return refuse("the Memory does not exist", "23503");
    if (m.owner_id !== next.owner_id) return refuse("owner_id is not the Memory's owner");
    if (m.state === "deleted") return refuse("the Memory is deleted");
    if (m.place_id !== next.split_from_place_id) return refuse("the Memory no longer stores the split place");
    const l = store.place_merge_log.find((x) => x.id === next.split_id);
    if (!l || l.action !== "split" || l.survivor_place_id !== next.split_from_place_id || !next.candidate_place_ids.includes(l.affected_place_id)) return refuse("split_id is not a split");
    if (next.state !== "pending" || next.decided_at != null || next.accepted_place_id != null) return refuse("a proposal is written pending");
    return null;
  }
  if (prev.state !== "pending") return refuse("a decided proposal is final");
  if (!["accepted", "dismissed"].includes(next.state)) return refuse("only accepted or dismissed");
  for (const k of ["id", "memory_id", "owner_id", "split_id", "split_from_place_id", "suggested_place_id", "created_at"]) if (prev[k] !== next[k]) return refuse("only the decision may change");
  if (JSON.stringify(prev.candidate_place_ids) !== JSON.stringify(next.candidate_place_ids) || JSON.stringify(prev.evidence) !== JSON.stringify(next.evidence)) return refuse("only the decision may change");
  if (next.state === "accepted") {
    const m = store.memories.find((x) => x.id === next.memory_id);
    if (!m || m.place_id !== next.accepted_place_id) return refuse("the Memory does not store the accepted place");
  }
  return null;
}

function makeDb(store: Record<string, any[]>, ops: Op[], w: World) {
  let idN = 0;
  const newId = () => `d7200000-0000-4000-8000-${String(++idN).padStart(12, "0")}`;
  function chain(table: string) {
    const filters: Array<(r: any) => boolean> = [];
    const filterText: string[] = [];
    let mode: "select" | "insert" | "update" | "upsert" = "select";
    let payload: any = null; let upsertOpts: any = null; let wantRows = false; let single = false;
    let limitN: number | null = null; let selected: string[] | null = null; let selectText = "";
    const orders: Array<[string, boolean]> = [];
    const f = (text: string, p: (r: any) => boolean) => { filters.push(p); filterText.push(text); return obj; };
    const obj: any = {
      select(c?: string) {
        if (mode !== "select") wantRows = true;
        if (typeof c === "string") { selectText = c; if (mode === "select") selected = c.split(",").map((k) => k.trim()).filter((k) => k && !k.includes("(") && !k.includes("!")); }
        return obj;
      },
      insert(d: any) { mode = "insert"; payload = d; return obj; },
      upsert(d: any, o: any) { mode = "upsert"; payload = d; upsertOpts = o; return obj; },
      update(d: any) { mode = "update"; payload = d; return obj; },
      delete() { throw new Error(`the job and routes never DELETE (${table})`); },
      eq: (c: string, v: any) => f(`${c}=${v}`, (r) => r[c] === v),
      neq: (c: string, v: any) => f(`${c}!=${v}`, (r) => r[c] !== v),
      in: (c: string, vs: any[]) => f(`${c} in ${vs.join("|")}`, (r) => vs.includes(r[c])),
      is: (c: string, v: any) => f(`${c} is ${v}`, (r) => (v === null ? r[c] == null : r[c] === v)),
      gt: (c: string, v: any) => f(`${c}>${v}`, (r) => String(r[c] ?? "") > String(v)),
      or() { throw new Error("this fake does not model or()"); },
      order(c: string, o?: any) { orders.push([c, o?.ascending !== false]); return obj; },
      limit(n: number) { limitN = n; return obj; },
      range(a: number, b: number) { limitN = b - a + 1; return obj; },
      maybeSingle() { single = true; return run(); },
      single() { single = true; return run(); },
      then(ok: any, bad: any) { return run().then(ok, bad); },
    };
    async function run(): Promise<any> {
      ops.push({ table, mode, cols: selectText, payload, filters: filterText.join(" & ") });
      if (mode === "select" && table === "feature_flags") {
        const asked = filterText.find((t) => t.startsWith("flag="))?.slice(5);
        if (asked && w.flags[asked] === "unreadable") return { data: null, error: { code: "57014", message: "feature_flags read failed" } };
      }
      if (mode === "select" && w.failReads?.has(table)) return { data: null, error: { code: "57014", message: `${table} read failed` } };
      if (mode !== "select" && w.failWrites?.has(table)) return { data: null, error: { code: "57014", message: `${table} write failed` } };
      const all = (store[table] ??= []);
      if (mode === "insert" || mode === "upsert") {
        const out: any[] = [];
        for (const raw of Array.isArray(payload) ? payload : [payload]) {
          const row = { id: newId(), state: "pending", accepted_place_id: null, decided_at: null, created_at: new Date().toISOString(), ...raw };
          if (table === "memory_place_reresolution_proposals") {
            const bad = guard(store, null, row);
            if (bad) return { data: null, error: bad };
            const check = proposalChecks(row);
            if (check) return { data: null, error: { code: "23514", message: `new row violates check constraint memory_place_reresolution_proposals_${check}` } };
            const dup = all.find((r) => r.memory_id === row.memory_id && r.split_id === row.split_id);
            if (dup) {
              if (mode === "upsert" && upsertOpts?.ignoreDuplicates && upsertOpts?.onConflict === "memory_id,split_id") continue;
              return { data: null, error: { code: "23505", message: "duplicate key value violates unique constraint memory_place_reresolution_proposals_once" } };
            }
          }
          all.push(row);
          out.push({ ...row });
        }
        return { data: wantRows ? out : null, error: null };
      }
      let matched = all.filter((r) => filters.every((p) => p(r)));
      if (mode === "update") {
        const out: any[] = [];
        for (const r of matched) {
          const next = { ...r, ...payload };
          if (table === "memory_place_reresolution_proposals") {
            const bad = guard(store, r, next) ?? (proposalChecks(next) ? { code: "23514", message: `check ${proposalChecks(next)}` } : null);
            if (bad) return { data: null, error: bad };
          }
          Object.assign(r, next);
          out.push({ ...r });
        }
        return { data: wantRows ? out : null, error: null };
      }
      if (orders.length > 0) matched = [...matched].sort((x, y) => { for (const [c, asc] of orders) { const d = String(x[c] ?? "").localeCompare(String(y[c] ?? "")); if (d !== 0) return asc ? d : -d; } return 0; });
      if (limitN != null) matched = matched.slice(0, limitN);
      const project = (x: any) => (selected && selected.length > 0 && !selected.includes("*") ? Object.fromEntries(selected.filter((k) => k in x).map((k) => [k, x[k]])) : { ...x });
      if (single) {
        if (matched.length > 1) return { data: null, error: { code: "PGRST116", message: "multiple rows" } };
        return { data: matched[0] ? project(matched[0]) : null, error: null };
      }
      return { data: matched.map(project), error: null };
    }
    return obj;
  }

  /** 3812's place_split, ported. */
  async function rpc(fn: string, args: any) {
    ops.push({ table: `rpc:${fn}`, mode: "rpc", payload: args });
    if (fn !== "place_split") return { data: null, error: { code: "PGRST202", message: `${fn} not modelled` } };
    if (w.failWrites?.has("places")) return { data: null, error: { code: "57014", message: "place_split failed" } };
    const on = (flag: string) => store.feature_flags.some((r) => r.flag === flag && r.enabled === true);
    if (!on(MEMORY_PLACE_SPLIT_FLAG) || !on(EXTERNAL_PLACES_FLAG)) return { data: { outcome: "disabled" }, error: null };
    const n = args.p_new ?? {};
    if (typeof n.latitude !== "number" || typeof n.longitude !== "number" || !String(n.name ?? "").trim()) return { data: { outcome: "invalid", detail: "required" }, error: null };
    const src = store.places.find((p) => p.id === args.p_place_id);
    if (!src) return { data: { outcome: "not_found" }, error: null };
    if (src.merged_into_place_id || src.status === "duplicate") return { data: { outcome: "merged" }, error: null };
    const refs: string[] = args.p_reference_ids ?? [];
    if (refs.some((id) => !store.external_place_references.some((r) => r.id === id && r.place_id === src.id))) return { data: { outcome: "reference_not_on_place" }, error: null };
    const newPlace = {
      id: newId(), name: String(n.name).trim(), normalized_name: n.normalized_name ?? "", primary_category: n.primary_category ?? src.primary_category,
      latitude: n.latitude, longitude: n.longitude, address: n.address ?? src.address, city: n.city ?? src.city, neighborhood: n.neighborhood ?? src.neighborhood,
      country_code: n.country_code ?? src.country_code, canonical_location_id: n.canonical_location_id ?? src.canonical_location_id, status: "active", merged_into_place_id: null,
    };
    store.places.push(newPlace);
    let moved = 0;
    for (const r of store.external_place_references) if (refs.includes(r.id) && r.place_id === src.id) { r.place_id = newPlace.id; moved += 1; }
    const log = { id: newId(), action: "split", survivor_place_id: src.id, affected_place_id: newPlace.id, admin_id: args.p_admin_id, ref_count: moved };
    store.place_merge_log.push(log);
    return { data: { outcome: "split", split_id: log.id, new_place_id: newPlace.id, references_moved: moved }, error: null };
  }

  return {
    from: (t: string) => chain(t),
    rpc,
    auth: { getUser: async (token: string) => ({ data: { user: { id: token, app_metadata: {} } }, error: null }) },
  };
}

interface App { base: string; store: Record<string, any[]>; ops: Op[]; w: World; db: any; close: () => Promise<void> }
const open: App[] = [];

async function start(w: World, opts: { mounted?: boolean | "api" | "with-memories"; mutate?: (s: Record<string, any[]>) => void } = {}): Promise<App> {
  const store = seed(w);
  opts.mutate?.(store);
  const ops: Op[] = [];
  const db = makeDb(store, ops, w);
  _setTestClient(db as any, true);
  const app = express();
  app.use(express.json());
  app.use((req: any, _r: any, n: any) => { req.log = { error: () => {}, info: () => {}, warn: () => {} }; n(); });
  if (opts.mounted === "api") app.use("/api", apiRouter);
  else if (opts.mounted === "with-memories") { app.use("/api", memoriesRouter); app.use("/api", memoryPlaceSplitRouter); }
  else if (opts.mounted !== false) app.use("/api", memoryPlaceSplitRouter);
  const srv = http.createServer(app);
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
  const { port } = srv.address() as { port: number };
  const a: App = { base: `http://127.0.0.1:${port}`, store, ops, w, db, close: () => new Promise<void>((r) => { srv.closeAllConnections(); srv.close(() => r()); }) };
  open.push(a);
  return a;
}
afterEach(async () => { while (open.length) await open.pop()!.close(); });

async function call(a: App, method: string, p: string, actor: string | null, body?: unknown, extra: Record<string, string> = {}) {
  const headers: Record<string, string> = { "Content-Type": "application/json", connection: "close", ...extra };
  if (actor) headers.Authorization = `Bearer ${actor}`;
  const res = await fetch(`${a.base}/api${p}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let parsed: any = text; try { parsed = text ? JSON.parse(text) : null; } catch { /* the default 404 page is HTML */ }
  return { status: res.status, type: res.headers.get("content-type"), body: parsed };
}

const SPLIT_BODY = { name: "Bar B", latitude: LAT, longitude: east(100), referenceIds: [REF_B] };
const writes = (a: App) => a.ops.filter((o) => o.mode !== "select");
const proposalFor = (a: App, memoryId: string) => a.store.memory_place_reresolution_proposals.filter((r) => r.memory_id === memoryId);

async function splitAsAdmin(a: App, body: unknown = SPLIT_BODY) {
  return call(a, "POST", `/admin/places/${P}/split`, ADMIN, body);
}

// ── The rule, pure ───────────────────────────────────────────────────────────

describe("decideProposal (Q-H72: 75 m + normalized-name match, else unresolved)", () => {
  const P1c = { id: P, name: "Cafe A", latitude: LAT, longitude: LNG };
  const P2c = { id: "p2", name: "Bar B", latitude: LAT, longitude: east(100) };
  const at = (lng: number, occurrenceName: string | null, lat = LAT) => ({ lat, lng, occurrenceName });

  it("exactly one candidate within 75 m with a matching name is suggested; the evidence holds only booleans", () => {
    const d = decideProposal(at(LNG, "Cafe A"), [P1c, P2c]);
    assert.equal(d.suggestedPlaceId, P);
    assert.equal(d.reason, "unique_within_bound_name_match");
    assert.deepEqual(d.evidence, { rule: "h72-v1", bound_m: 75, reason: "unique_within_bound_name_match", candidates: [
      { place_id: P, within_bound: true, name_match: true }, { place_id: "p2", within_bound: false, name_match: false },
    ] });
    assert.equal(decideProposal(at(east(100), "BAR  b!"), [P1c, P2c]).suggestedPlaceId, "p2", "the catalog normalizer folds case and punctuation");
  });
  it("equidistant inside the bound, equidistant outside it, a mismatched name, no point, no name: all unresolved", () => {
    assert.deepEqual([decideProposal(at(east(50), "Cafe A"), [P1c, P2c])].map((d) => [d.suggestedPlaceId, d.reason]), [[null, "several_within_bound"]]);
    assert.deepEqual([decideProposal(at(east(50), "Cafe A", north(150)), [P1c, P2c])].map((d) => [d.suggestedPlaceId, d.reason]), [[null, "none_within_bound"]]);
    assert.deepEqual([decideProposal(at(LNG, "Somewhere Else"), [P1c, P2c])].map((d) => [d.suggestedPlaceId, d.reason]), [[null, "name_mismatch"]]);
    assert.deepEqual([decideProposal({ lat: null, lng: LNG, occurrenceName: "Cafe A" }, [P1c, P2c])].map((d) => [d.suggestedPlaceId, d.reason]), [[null, "no_coordinates"]]);
    assert.deepEqual([decideProposal({ lat: LAT, lng: null, occurrenceName: "Cafe A" }, [P1c, P2c])].map((d) => [d.suggestedPlaceId, d.reason]), [[null, "no_coordinates"]]);
    assert.deepEqual([decideProposal(at(LNG, null), [P1c, P2c])].map((d) => [d.suggestedPlaceId, d.reason]), [[null, "no_occurrence_name"]]);
    assert.deepEqual([decideProposal(at(LNG, "   "), [P1c, P2c])].map((d) => [d.suggestedPlaceId, d.reason]), [[null, "no_occurrence_name"]]);
  });
  it("a candidate with no position makes the Memory unresolved (uniqueness cannot be shown)", () => {
    const d = decideProposal(at(LNG, "Cafe A"), [P1c, { ...P2c, latitude: null }]);
    assert.deepEqual([d.suggestedPlaceId, d.reason], [null, "candidate_without_coordinates"]);
  });
  it("names that normalize to nothing (non-Latin scripts) never match each other", () => {
    assert.equal(normalizedPlaceName("東京タワー"), null);
    const d = decideProposal(at(LNG, "東京タワー"), [{ ...P1c, name: "スカイツリー" }, P2c]);
    assert.deepEqual([d.suggestedPlaceId, d.reason], [null, "no_occurrence_name"]);
    const d2 = decideProposal(at(LNG, "Cafe A"), [{ ...P1c, name: "東京タワー" }, P2c]);
    assert.deepEqual([d2.suggestedPlaceId, d2.reason], [null, "name_mismatch"]);
  });
  it("the bound is inclusive at 75 m and exclusive beyond it", () => {
    assert.equal(RERESOLUTION_BOUND_M, 75);
    assert.equal(decideProposal(at(east(74), "Cafe A"), [P1c, { ...P2c, longitude: east(500) }]).suggestedPlaceId, P);
    assert.equal(decideProposal(at(east(76), "Cafe A"), [P1c, { ...P2c, longitude: east(500) }]).reason, "none_within_bound");
    assert.ok(Math.abs(distanceMeters(LAT, LNG, LAT, east(100)) - 100) < 0.5, "the geometry the fixtures rely on");
  });
  it("combineGates: off or absent wins; any unreadable otherwise refuses; on only when both are on", () => {
    assert.equal(combineGates("on", "on"), "on");
    for (const [x, y] of [["off", "on"], ["on", "absent"], ["off", "unreadable"], ["unreadable", "absent"]] as const) assert.equal(combineGates(x, y), "off", `${x}/${y}`);
    for (const [x, y] of [["unreadable", "on"], ["on", "unreadable"], ["unreadable", "unreadable"]] as const) assert.equal(combineGates(x, y), "unreadable", `${x}/${y}`);
  });
});

// ── The split and the job ────────────────────────────────────────────────────

describe("S/U/C/W — the admin split and the re-resolution job", () => {
  it("S: split P into P1 (kept) and P2; the Memory at P1 is suggested P1, the one at P2 is suggested P2", async () => {
    const a = await start({ flags: { ...ON, [OCCURRENCE_NAME_FLAG]: true } });
    const r = await splitAsAdmin(a);
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const p2 = r.body.newPlaceId;
    assert.equal(r.body.placeId, P);
    assert.equal(r.body.referencesMoved, 1);
    assert.equal(a.store.external_place_references.find((x) => x.id === REF_B).place_id, p2, "the named reference moved");
    assert.equal(a.store.external_place_references.find((x) => x.id === REF_A).place_id, P, "the other stayed");
    assert.deepEqual(a.store.place_merge_log.map((l) => [l.action, l.survivor_place_id, l.affected_place_id, l.admin_id]), [["split", P, p2, ADMIN]]);
    assert.equal(a.store.places.find((x) => x.id === p2).city, "Da Nang", "descriptive fields not given are the source's");
    const [p1] = proposalFor(a, M_AT_P1);
    assert.equal(p1.suggested_place_id, P);
    assert.deepEqual(p1.candidate_place_ids, [P, p2]);
    assert.equal(p1.owner_id, A);
    assert.equal(p1.state, "pending");
    assert.equal(proposalFor(a, M_AT_P2)[0].suggested_place_id, p2);
    assert.equal(proposalFor(a, M_B)[0].suggested_place_id, P, "every owner's Memory at the split place is re-resolved, each to its owner");
    assert.equal(proposalFor(a, M_B)[0].owner_id, B);
    assert.deepEqual(r.body.reresolution, { state: "done", scanned: 9, proposed: 8, suggested: 3, unresolved: 5, alreadyProposed: 0, skippedCorrected: 1, skippedUnreadable: 0, skippedChanged: 0, failed: 0 });
  });

  it("U: equidistant (both within, or neither), a name mismatch, no point, no occurrence name — suggested_place_id is null", async () => {
    const a = await start({ flags: { ...ON, [OCCURRENCE_NAME_FLAG]: true } });
    assert.equal((await splitAsAdmin(a)).status, 201);
    const got = (m: string) => { const [p] = proposalFor(a, m); return [p.suggested_place_id, p.evidence.reason]; };
    assert.deepEqual(got(M_EQUI), [null, "several_within_bound"]);
    assert.deepEqual(got(M_EQUI_FAR), [null, "none_within_bound"]);
    assert.deepEqual(got(M_NAME), [null, "name_mismatch"]);
    assert.deepEqual(got(M_NOCOORD), [null, "no_coordinates"]);
    assert.deepEqual(got(M_NONAME), [null, "no_occurrence_name"]);
    for (const p of a.store.memory_place_reresolution_proposals) {
      const text = JSON.stringify(p.evidence);
      assert.doesNotMatch(text, /10\.0|106\.|lat|lng|Cafe|Bar/, "no coordinate or name is stored in a proposal");
    }
  });

  it("C: a Memory with any owner place correction gets NO proposal", async () => {
    const a = await start({ flags: { ...ON, [OCCURRENCE_NAME_FLAG]: true } });
    assert.equal((await splitAsAdmin(a)).status, 201);
    assert.equal(proposalFor(a, M_CORRECTED).length, 0);
  });

  it("C: an unreadable corrections read gets no proposal either (counted, the run is incomplete)", async () => {
    const a = await start({ flags: { ...ON, [OCCURRENCE_NAME_FLAG]: true }, failReads: new Set(["memory_corrections"]) });
    const r = await splitAsAdmin(a);
    assert.equal(r.status, 201);
    assert.equal(a.store.memory_place_reresolution_proposals.length, 0);
    assert.equal(r.body.reresolution.state, "incomplete");
    assert.equal(r.body.reresolution.skippedUnreadable, 9);
  });

  it("C: 3673 absent (42P01) means no correction exists — every live Memory at the place is proposed", async () => {
    const a = await start({ flags: { ...ON, [OCCURRENCE_NAME_FLAG]: true } }, { mutate: (s) => { delete (s as any).memory_corrections; } });
    const db = a.db; const from = db.from;
    db.from = (t: string) => (t === "memory_corrections" ? { select: () => { const q: any = { eq: () => q, in: () => q, order: () => q, limit: () => q, then: (ok: any) => Promise.resolve({ data: null, error: { code: "42P01", message: "relation \"memory_corrections\" does not exist" } }).then(ok) }; return q; } } : from(t));
    const r = await splitAsAdmin(a);
    assert.equal(r.body.reresolution.proposed, 9);
    assert.equal(proposalFor(a, M_CORRECTED).length, 1);
  });

  it("W: the job never writes memories or memory_corrections; only proposals and the split itself are written", async () => {
    const a = await start({ flags: { ...ON, [OCCURRENCE_NAME_FLAG]: true } });
    const before = JSON.stringify(a.store.memories);
    assert.equal((await splitAsAdmin(a)).status, 201);
    const tables = new Set(writes(a).map((o) => o.table));
    assert.deepEqual([...tables].sort(), ["memory_place_reresolution_proposals", "rpc:place_split"]);
    assert.equal(JSON.stringify(a.store.memories), before, "no Memory changed");
    assert.ok(!writes(a).some((o) => o.table === "memories" || o.table === "memory_corrections"));
    assert.ok(a.ops.some((o) => o.table === "memories" && o.mode === "select"), "it did read the Memories (anti-vacuity)");
  });

  it("W: deleted, removed and elsewhere Memories are not read as the split place's; the read pages by id", async () => {
    const a = await start({ flags: { ...ON, [OCCURRENCE_NAME_FLAG]: true } });
    assert.equal((await splitAsAdmin(a)).status, 201);
    for (const m of [M_DELETED, M_REMOVED, M_ELSEWHERE]) assert.equal(proposalFor(a, m).length, 0, m);
    const read = a.ops.find((o) => o.table === "memories" && o.mode === "select")!;
    assert.match(read.filters!, new RegExp(`place_id=${P}`));
    assert.match(read.filters!, /state in draft\|published\|archived/);
    assert.match(read.filters!, /id>00000000-0000-0000-0000-000000000000/);
  });

  it("W: a re-run is idempotent — no second proposal, counted as already proposed", async () => {
    const a = await start({ flags: { ...ON, [OCCURRENCE_NAME_FLAG]: true } });
    const r = await splitAsAdmin(a);
    const n = a.store.memory_place_reresolution_proposals.length;
    const again = await call(a, "POST", `/admin/places/splits/${r.body.splitId}/reresolve`, ADMIN);
    assert.equal(again.status, 200, JSON.stringify(again.body));
    assert.equal(a.store.memory_place_reresolution_proposals.length, n);
    assert.equal(again.body.reresolution.alreadyProposed, 8);
    assert.equal(again.body.reresolution.proposed, 0);
  });

  it("W: a Memory deleted between the read and the write is refused by the guard and counted, not failed", async () => {
    const a = await start({ flags: { ...ON, [OCCURRENCE_NAME_FLAG]: true } });
    const db = a.db; const from = db.from;
    let deletedOnce = false;
    db.from = (t: string) => {
      if (t === "memory_place_reresolution_proposals" && !deletedOnce) { deletedOnce = true; a.store.memories.find((m) => m.id === M_AT_P1).state = "deleted"; }
      return from(t);
    };
    const r = await splitAsAdmin(a);
    assert.equal(proposalFor(a, M_AT_P1).length, 0);
    assert.equal(r.body.reresolution.skippedChanged, 1);
    assert.equal(r.body.reresolution.failed, 0);
    assert.equal(r.body.reresolution.state, "done");
  });

  it("W: a proposal write that fails is counted failed and the run reports incomplete", async () => {
    const a = await start({ flags: { ...ON, [OCCURRENCE_NAME_FLAG]: true }, failWrites: new Set(["memory_place_reresolution_proposals"]) });
    const r = await splitAsAdmin(a);
    assert.equal(r.status, 201);
    assert.equal(r.body.reresolution.state, "incomplete");
    assert.equal(r.body.reresolution.failed, 8, "the corrected Memory is never written");
  });

  it("the occurrence-name gate: absent (3804 unapplied) ⇒ the column is never named and no name can match; unreadable ⇒ the job refuses", async () => {
    const absent = await start({ flags: { [MEMORY_PLACE_SPLIT_FLAG]: true, [EXTERNAL_PLACES_FLAG]: true } });
    assert.equal((await splitAsAdmin(absent)).status, 201);
    const read = absent.ops.find((o) => o.table === "memories" && o.mode === "select")!;
    assert.doesNotMatch(read.cols!, /place_display_name_at_occurrence/);
    assert.equal(proposalFor(absent, M_AT_P1)[0].evidence.reason, "no_occurrence_name");
    const off = await start({ flags: { ...ON } });
    assert.equal((await splitAsAdmin(off)).status, 201);
    assert.match(off.ops.find((o) => o.table === "memories" && o.mode === "select")!.cols!, /place_display_name_at_occurrence/, "OFF still means the column exists (3804 seeds its flag with the column)");
    assert.equal(proposalFor(off, M_AT_P1)[0].suggested_place_id, P);
    const unreadable = await start({ flags: { ...ON, [OCCURRENCE_NAME_FLAG]: "unreadable" } });
    const r = await splitAsAdmin(unreadable);
    assert.equal(r.status, 201, "the split itself is committed");
    assert.equal(r.body.reresolution.state, "unreadable");
    assert.equal(unreadable.store.memory_place_reresolution_proposals.length, 0);
    assert.ok(!unreadable.ops.some((o) => o.table === "memories"));
  });

  it("split refusals: a merged-away place, a reference that is not the place's, a missing place, a bad body, a non-admin", async () => {
    const a = await start({ flags: { ...ON } }, { mutate: (s) => { s.places.push({ id: ELSEWHERE.replace(/9$/, "8"), name: "Dup", status: "duplicate", merged_into_place_id: P, latitude: LAT, longitude: LNG }); } });
    const merged = await call(a, "POST", `/admin/places/${ELSEWHERE.replace(/9$/, "8")}/split`, ADMIN, SPLIT_BODY);
    assert.deepEqual([merged.status, merged.body.reason], [409, "place_merged"]);
    const foreignRef = await splitAsAdmin(a, { ...SPLIT_BODY, referenceIds: [randomUUID()] });
    assert.deepEqual([foreignRef.status, foreignRef.body.reason], [400, "reference_not_on_place"]);
    const missing = await call(a, "POST", `/admin/places/${randomUUID()}/split`, ADMIN, SPLIT_BODY);
    assert.equal(missing.status, 404);
    for (const body of [{ name: "x" }, { ...SPLIT_BODY, latitude: 91 }, { ...SPLIT_BODY, name: " " }, { ...SPLIT_BODY, extra: 1 }]) {
      assert.equal((await splitAsAdmin(a, body)).status, 400, JSON.stringify(body));
    }
    const notAdmin = await call(a, "POST", `/admin/places/${P}/split`, A, SPLIT_BODY);
    assert.equal(notAdmin.status, 403);
    assert.equal(a.store.place_merge_log.length, 0);
    assert.equal(a.store.places.length, 3, "nothing was created");
    assert.equal(a.store.memory_place_reresolution_proposals.length, 0);
  });

  it("place_split failing is a 503 and nothing else runs", async () => {
    const a = await start({ flags: { ...ON }, failWrites: new Set(["places"]) });
    const r = await splitAsAdmin(a);
    assert.equal(r.status, 503);
    assert.ok(!a.ops.some((o) => o.table === "memories"));
  });
});

// ── Flags ────────────────────────────────────────────────────────────────────

describe("F — flags OFF: the split is refused and the job is inert", () => {
  for (const flags of [
    { [MEMORY_PLACE_SPLIT_FLAG]: false, [EXTERNAL_PLACES_FLAG]: true },
    { [EXTERNAL_PLACES_FLAG]: true },
    { [MEMORY_PLACE_SPLIT_FLAG]: true, [EXTERNAL_PLACES_FLAG]: false },
    { [MEMORY_PLACE_SPLIT_FLAG]: true },
  ] as Array<Record<string, FlagValue>>) {
    it(`split refused, nothing written, nothing read past the flags: ${JSON.stringify(flags)}`, async () => {
      const a = await start({ flags });
      const r = await splitAsAdmin(a);
      assert.deepEqual([r.status, r.body.error], [404, "feature_disabled"]);
      assert.deepEqual(writes(a), []);
      assert.deepEqual([...new Set(a.ops.map((o) => o.table))].sort(), ["feature_flags", "profiles"]);
      const rerun = await call(a, "POST", `/admin/places/splits/${randomUUID()}/reresolve`, ADMIN);
      assert.deepEqual([rerun.status, rerun.body.error], [404, "feature_disabled"]);
    });
  }

  it("the job alone, flags off: inert, and it reads nothing but feature_flags", async () => {
    const a = await start({ flags: { [MEMORY_PLACE_SPLIT_FLAG]: false, [EXTERNAL_PLACES_FLAG]: true } }, {
      mutate: (s) => { s.place_merge_log.push({ id: "d7200000-0000-4000-8000-0000000000ff", action: "split", survivor_place_id: P, affected_place_id: ELSEWHERE }); },
    });
    const out = await runSplitReresolution(a.db, "d7200000-0000-4000-8000-0000000000ff");
    assert.deepEqual(out, { state: "inert" });
    assert.deepEqual([...new Set(a.ops.map((o) => o.table))], ["feature_flags"]);
    assert.deepEqual(writes(a), []);
  });

  it("place_split itself refuses while a flag is off (the SQL's own check, ported)", async () => {
    const a = await start({ flags: { [MEMORY_PLACE_SPLIT_FLAG]: false, [EXTERNAL_PLACES_FLAG]: true } });
    const r = await a.db.rpc("place_split", { p_place_id: P, p_new: { name: "Bar B", latitude: LAT, longitude: LNG }, p_reference_ids: [], p_admin_id: ADMIN });
    assert.deepEqual(r.data, { outcome: "disabled" });
  });

  it("an unreadable flag: the split is 503 and the owner routes are 503, never 'does not exist'", async () => {
    const a = await start({ flags: { [MEMORY_PLACE_SPLIT_FLAG]: "unreadable", [EXTERNAL_PLACES_FLAG]: true } });
    const r = await splitAsAdmin(a);
    assert.equal(r.status, 503);
    assert.deepEqual(writes(a), []);
    const list = await call(a, "GET", "/me/memory-place-proposals", A);
    assert.equal(list.status, 503);
  });

  it("owner routes OFF/absent: the same answer as an app WITHOUT the router, before authentication, nothing read past the flags", async () => {
    for (const flags of [{ [MEMORY_PLACE_SPLIT_FLAG]: false, [EXTERNAL_PLACES_FLAG]: true }, { [EXTERNAL_PLACES_FLAG]: true }] as Array<Record<string, FlagValue>>) {
      const without = await start({ flags }, { mounted: false });
      const withR = await start({ flags }); // started last: its fake is the injected client both apps' requests reach
      for (const [method, p, body] of [["GET", "/me/memory-place-proposals"], ["POST", `/memory-place-proposals/${randomUUID()}/accept`, { placeId: P }], ["POST", `/memory-place-proposals/${randomUUID()}/dismiss`]] as const) {
        for (const actor of [A, null]) {
          const x = await call(withR, method, p, actor, body);
          const y = await call(without, method, p, actor, body);
          assert.deepEqual([x.status, x.type, x.body], [y.status, y.type, y.body], `${method} ${p} ${actor}`);
        }
      }
      assert.deepEqual([...new Set(withR.ops.map((o) => o.table))], ["feature_flags"]);
      assert.deepEqual(writes(withR), []);
    }
  });

  it("mounted through routes/index.ts's real router", async () => {
    const a = await start({ flags: { ...ON } }, { mounted: "api" });
    const r = await call(a, "GET", "/me/memory-place-proposals", A);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body, { proposals: [] });
  });
});

// ── The owner's side ─────────────────────────────────────────────────────────

describe("O — the owner's proposals: read, accept after the PATCH, dismiss", () => {
  async function splitWorld(over: Partial<World> = {}) {
    const a = await start({ flags: { ...ON, [OCCURRENCE_NAME_FLAG]: true }, ...over });
    const r = await splitAsAdmin(a);
    assert.equal(r.status, 201);
    return { a, p2: r.body.newPlaceId as string, splitId: r.body.splitId as string };
  }

  it("the owner reads only their own pending proposals: candidates with their public names, no coordinates", async () => {
    const { a, p2 } = await splitWorld();
    const r = await call(a, "GET", "/me/memory-place-proposals", A);
    assert.equal(r.status, 200);
    const ids = r.body.proposals.map((p: any) => p.memoryId).sort();
    assert.deepEqual(ids, [M_AT_P1, M_AT_P2, M_EQUI, M_EQUI_FAR, M_NAME, M_NOCOORD, M_NONAME].sort());
    const one = r.body.proposals.find((p: any) => p.memoryId === M_AT_P1);
    assert.deepEqual(Object.keys(one).sort(), ["candidates", "createdAt", "id", "memoryId", "reason", "splitFromPlaceId", "suggestedPlaceId"]);
    assert.deepEqual(one.candidates, [{ placeId: P, name: "Cafe A" }, { placeId: p2, name: "Bar B" }]);
    assert.equal(one.suggestedPlaceId, P);
    assert.doesNotMatch(JSON.stringify(r.body), /location_lat|location_lng|"lat"|"lng"|latitude|longitude|"within_bound"|"name_match"|"evidence"|106\.|10\.0/);
    const b = await call(a, "GET", "/me/memory-place-proposals", B);
    assert.deepEqual(b.body.proposals.map((p: any) => p.memoryId), [M_B]);
    const filtered = await call(a, "GET", `/me/memory-place-proposals?memoryId=${M_AT_P2}`, A);
    assert.deepEqual(filtered.body.proposals.map((p: any) => p.memoryId), [M_AT_P2]);
    assert.equal((await call(a, "GET", "/me/memory-place-proposals?memoryId=nope", A)).status, 400);
    assert.equal((await call(a, "GET", "/me/memory-place-proposals", null)).status, 401);
  });

  it("a proposal stops being offered once the Memory moved, was deleted, or the owner corrected its place since", async () => {
    const { a } = await splitWorld();
    a.store.memories.find((m) => m.id === M_AT_P1).place_id = ELSEWHERE;
    a.store.memories.find((m) => m.id === M_EQUI).state = "deleted";
    a.store.memory_corrections.push({ id: "c7200000-0000-4000-8000-000000000002", memory_id: M_NAME, owner_id: A, field: "place", kind: "reject", place_id: ELSEWHERE, canonical_location_id: null, created_at: "2026-10-14T00:00:00.000Z", source: "correction_route" });
    const r = await call(a, "GET", "/me/memory-place-proposals", A);
    const ids = r.body.proposals.map((p: any) => p.memoryId);
    for (const gone of [M_AT_P1, M_EQUI, M_NAME]) assert.ok(!ids.includes(gone), gone);
    assert.ok(ids.includes(M_AT_P2));
  });

  it("any unreadable read on the owner path is a 503, never a partial list", async () => {
    for (const t of ["memory_place_reresolution_proposals", "memories", "memory_corrections", "places"]) {
      const { a } = await splitWorld();
      a.w.failReads = new Set([t]);
      const r = await call(a, "GET", "/me/memory-place-proposals", A);
      assert.equal(r.status, 503, t);
    }
  });

  it("accept: refused until the Memory stores the chosen place (the change is PATCH /memories/:id); then recorded once; nothing else written", async () => {
    const { a, p2 } = await splitWorld();
    const [prop] = proposalFor(a, M_AT_P2);
    const early = await call(a, "POST", `/memory-place-proposals/${prop.id}/accept`, A, { placeId: p2 });
    assert.deepEqual([early.status, early.body.reason], [409, "memory_not_changed"]);
    assert.equal(prop.state, "pending");
    // The owner's PATCH /memories/:id is the one writer of the place (H-10); modelled here as its committed effect.
    a.store.memories.find((m) => m.id === M_AT_P2).place_id = p2;
    const n = a.ops.length;
    const ok = await call(a, "POST", `/memory-place-proposals/${prop.id}/accept`, A, { placeId: p2 });
    assert.deepEqual([ok.status, ok.body], [200, { proposalId: prop.id, state: "accepted", placeId: p2 }]);
    assert.equal(prop.state, "accepted");
    assert.equal(prop.accepted_place_id, p2);
    assert.ok(prop.decided_at);
    assert.deepEqual(a.ops.slice(n).filter((o) => o.mode !== "select").map((o) => o.table), ["memory_place_reresolution_proposals"], "accept writes only the proposal");
    const twice = await call(a, "POST", `/memory-place-proposals/${prop.id}/accept`, A, { placeId: p2 });
    assert.deepEqual([twice.status, twice.body.reason], [409, "already_decided"]);
  });

  it("end to end over the REAL PATCH /memories/:id: the owner moves the Memory to P2 (recorded as their correction), then accepts; the proposal is no longer offered", async () => {
    const a = await start({ flags: { ...ON, [OCCURRENCE_NAME_FLAG]: true } }, { mounted: "with-memories" });
    const split = await splitAsAdmin(a);
    assert.equal(split.status, 201, JSON.stringify(split.body));
    const p2 = split.body.newPlaceId as string;
    const [prop] = proposalFor(a, M_AT_P2);
    const patch = await call(a, "PATCH", `/memories/${M_AT_P2}`, A, { placeId: p2 }, { "Idempotency-Key": `h72-${randomUUID()}` });
    assert.equal(patch.status, 200, JSON.stringify(patch.body));
    assert.equal(a.store.memories.find((m) => m.id === M_AT_P2).place_id, p2, "the PATCH, not this feature, wrote the Memory's place");
    assert.ok(a.store.memory_corrections.some((c) => c.memory_id === M_AT_P2 && c.kind === "assert" && c.place_id === p2), "the PATCH recorded the owner's correction");
    const ok = await call(a, "POST", `/memory-place-proposals/${prop.id}/accept`, A, { placeId: p2 });
    assert.deepEqual([ok.status, ok.body.state], [200, "accepted"]);
    const list = await call(a, "GET", "/me/memory-place-proposals", A);
    assert.ok(!list.body.proposals.some((p: any) => p.memoryId === M_AT_P2));
  });

  it("accept the kept place: the Memory already stores it, so no PATCH is needed", async () => {
    const { a } = await splitWorld();
    const [prop] = proposalFor(a, M_AT_P1);
    const ok = await call(a, "POST", `/memory-place-proposals/${prop.id}/accept`, A, { placeId: P });
    assert.equal(ok.status, 200);
    assert.equal(prop.state, "accepted");
  });

  it("accept refusals: not a candidate, someone else's, a missing one, a malformed id or place", async () => {
    const { a } = await splitWorld();
    const [prop] = proposalFor(a, M_AT_P1);
    const notCand = await call(a, "POST", `/memory-place-proposals/${prop.id}/accept`, A, { placeId: ELSEWHERE });
    assert.deepEqual([notCand.status, notCand.body.reason], [400, "not_a_candidate"]);
    const foreign = await call(a, "POST", `/memory-place-proposals/${prop.id}/accept`, B, { placeId: P });
    const missing = await call(a, "POST", `/memory-place-proposals/${randomUUID()}/accept`, B, { placeId: P });
    assert.deepEqual([foreign.status, foreign.body], [missing.status, missing.body], "someone else's proposal is the same 404 as none");
    assert.equal(foreign.status, 404);
    assert.equal((await call(a, "POST", "/memory-place-proposals/nope/accept", A, { placeId: P })).status, 404);
    assert.equal((await call(a, "POST", `/memory-place-proposals/${prop.id}/accept`, A, { placeId: "nope" })).status, 400);
    assert.equal(prop.state, "pending");
  });

  it("accept on a deleted Memory is a 404; an unreadable read or a failed write is a 503", async () => {
    const { a } = await splitWorld();
    const [prop] = proposalFor(a, M_AT_P1);
    a.store.memories.find((m) => m.id === M_AT_P1).state = "deleted";
    assert.equal((await call(a, "POST", `/memory-place-proposals/${prop.id}/accept`, A, { placeId: P })).status, 404);
    a.store.memories.find((m) => m.id === M_AT_P1).state = "published";
    a.w.failReads = new Set(["memories"]);
    assert.equal((await call(a, "POST", `/memory-place-proposals/${prop.id}/accept`, A, { placeId: P })).status, 503);
    a.w.failReads = new Set();
    a.w.failWrites = new Set(["memory_place_reresolution_proposals"]);
    assert.equal((await call(a, "POST", `/memory-place-proposals/${prop.id}/accept`, A, { placeId: P })).status, 503);
    assert.equal(prop.state, "pending");
  });

  it("dismiss: the owner's, once; the Memory keeps its place; someone else's is a 404", async () => {
    const { a } = await splitWorld();
    const [prop] = proposalFor(a, M_EQUI);
    const foreign = await call(a, "POST", `/memory-place-proposals/${prop.id}/dismiss`, B);
    assert.equal(foreign.status, 404);
    const ok = await call(a, "POST", `/memory-place-proposals/${prop.id}/dismiss`, A);
    assert.deepEqual([ok.status, ok.body], [200, { proposalId: prop.id, state: "dismissed" }]);
    assert.equal(prop.state, "dismissed");
    assert.equal(a.store.memories.find((m) => m.id === M_EQUI).place_id, P);
    const again = await call(a, "POST", `/memory-place-proposals/${prop.id}/dismiss`, A);
    assert.deepEqual([again.status, again.body.reason], [409, "already_decided"]);
    const list = await call(a, "GET", "/me/memory-place-proposals", A);
    assert.ok(!list.body.proposals.some((p: any) => p.id === prop.id), "a dismissed proposal is no longer offered");
  });
});
