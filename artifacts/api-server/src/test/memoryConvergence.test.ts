/**
 * H180 — photos from the owner's other device converge on the Memory they
 * belong to, as a proposal only the owner's Keep attaches
 * (census-highlights-memories H180, census §BY; migration 3806).
 *
 * Over the REAL candidate router and a table-backed fake that models what the
 * database would enforce:
 *   - 2320: the episode replay key, the evidence dedupe key, and `recorded_at`
 *     stamped by the DATABASE's clock on every evidence row (it moves forward);
 *   - 3806: the primary key (owner, Memory, photo), ON CONFLICT DO NOTHING, the
 *     guard trigger (a Memory or a photo of another owner is refused; a
 *     decided row is final) and the decision-stamped CHECK;
 *   - 3672 on or off: `memory_items.visibility` exists or is a missing column;
 *   - the §17 kernel on or off: with it on, ADD_MEDIA is an RPC that keys on
 *     (actor, idempotency key), assigns its own item id and takes NO photo
 *     audience — exactly 2711's `INSERT INTO memory_items (memory_id,
 *     media_url, media_type, caption, position)`.
 * Every assertion is on the STORE or the wire.
 *
 * WHAT THIS SUITE HOLDS (the census row's own test list first)
 *   - Memory M 19:00–22:00 on trip T; photos from device B at 20:15 and 21:30
 *     ⇒ ONE convergence proposal per photo for M, and no new candidate.
 *   - Keep twice ⇒ one item per photo (direct write, kernel, and concurrent).
 *   - A dismissed photo is never proposed again, nor resurfaced as a candidate.
 *   - Keep onto a non-only_me Memory without echoing its audience ⇒ 409, nothing
 *     written; a stale echo ⇒ 409 with the current audience.
 *   - Another person's Memory is never proposed to; a Memory on another trip is
 *     not either.
 *   - A late capture of a KEPT episode is proposed to its Memory, and a retried
 *     Keep of that episode no longer attaches it unseen.
 *
 * Run: node --import tsx/esm --test src/test/memoryConvergence.test.ts
 */
import { describe, it, afterEach, beforeEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import memoryCandidatesRouter from "../routes/memoryCandidates.js";
import { resetHighlightSchemaMemo } from "../services/highlights/highlightSchemaAvailability.js";
import { _resetMemoryKernelMetrics } from "../services/memory/memoryKernelMetrics.js";
import { MAX_CONVERGENCE_WINDOW_MS, memoryWindow, windowsContaining } from "../services/memory/memoryConvergenceStore.js";
import { convergenceItemKey } from "../services/memory/memoryConvergence.js";
import { recordedAfterLink, candidateItemId } from "../services/memory/episodeCandidates.js";
import { runMemoryDeletionLifecycle } from "../services/memory/memoryDeletionLifecycle.js";

const OWNER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const TRIP = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
/** A side trip whose dates overlap TRIP's: the same instant can be inside both windows. */
const SIDE_TRIP = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const M = "90000000-0000-4000-8000-00000000000a";
const M2 = "90000000-0000-4000-8000-00000000000b";
const THEIRS = "90000000-0000-4000-8000-00000000000c";
const TABLE = "memory_convergence_proposals";

const a = (n: number) => `30000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const url = (n: number, who = OWNER) => `post-media/${who}/p${n}.jpg`;

function media(n: number, captured: string | null, over: Record<string, unknown> = {}) {
  return {
    id: a(n), owner_user_id: OWNER, media_type: "image", mime_type: "image/jpeg", public_url: url(n),
    captured_at: captured, source_type: "user", moderation_status: "approved", processing_status: "ready",
    deleted_at: null, provenance: null, created_at: "2026-03-02T23:00:00.000Z", ...over,
  };
}

function memory(id: string, over: Record<string, unknown> = {}) {
  return {
    id, owner_id: OWNER, title: "Fado night", caption: null, visibility: "only_me", allowed_user_ids: [], hidden_user_ids: [],
    trip_id: TRIP, event_id: null, place_id: null, starts_at: "2026-03-02T19:00:00.000Z", ends_at: "2026-03-02T22:00:00.000Z",
    state: "published", created_at: "2026-03-02T22:30:00.000Z", updated_at: "2026-03-02T22:30:00.000Z", ...over,
  };
}

/**
 * Phone A made Memory M (19:00–22:00, one photo at 19:05). Device B's photos
 * from the same evening (20:15, 21:30) arrive later, plus a lunch the next day.
 */
function seed(): Record<string, any[]> {
  return {
    feature_flags: [],
    trips: [
      { id: TRIP, owner_id: OWNER, start_date: "2026-03-01", end_date: "2026-03-05", destination_city: "Lisbon", destination_country: "Portugal" },
      { id: SIDE_TRIP, owner_id: OWNER, start_date: "2026-03-02", end_date: "2026-03-03", destination_city: "Sintra", destination_country: "Portugal" },
    ],
    trip_members: [],
    media_assets: [
      media(1, "2026-03-02T19:05:00.000Z"),                 // phone A, already in M
      media(2, "2026-03-02T20:15:00.000Z"),                 // device B, inside M
      media(3, "2026-03-02T21:30:00.000Z"),                 // device B, inside M
      media(4, "2026-03-03T13:00:00.000Z"), media(5, "2026-03-03T13:40:00.000Z"), // the next day's lunch
    ],
    memories: [memory(M)],
    memory_items: [{ id: "91000000-0000-4000-8000-000000000001", memory_id: M, media_url: url(1), media_type: "image/jpeg", caption: null, position: 0 }],
    memory_episodes: [],
    memory_evidence: [],
    [TABLE]: [],
  };
}

let gen = 0;
const newId = () => `e${String(++gen).padStart(7, "0")}-0000-4000-8000-000000000000`;
/** The DATABASE's clock (2320's recorded_at default now()): strictly forward, microseconds. */
let dbTick = 0;
const dbNow = () => `2026-10-05T00:00:${String(Math.floor(++dbTick / 1000)).padStart(2, "0")}.${String(dbTick % 1000).padStart(3, "0")}123+00:00`;

interface FakeOpts {
  absent?: Set<string>;
  failReads?: Set<string>;
  failWrites?: Set<string>;
  /** 3672 applied: memory_items.visibility exists. Default: not applied (production today). */
  itemVisibility?: boolean;
  /** memory_kernel_enabled ON, with 2711's ADD_MEDIA modelled. */
  kernel?: boolean;
  beforeUpdate?: (table: string, store: Record<string, any[]>) => void;
}

function makeClient(store: Record<string, any[]>, opts: FakeOpts, receipts = new Map<string, any>()) {
  const writes: Array<{ table: string; mode: string; payload: any }> = [];
  function chain(table: string) {
    const filters: Array<(r: any) => boolean> = [];
    let single = false, wantRows = false, cols = "";
    let mode: "select" | "insert" | "upsert" | "update" | "delete" = "select";
    let payload: any = null;
    let upsertOpts: { onConflict?: string; ignoreDuplicates?: boolean } = {};
    let limitN: number | null = null;
    let orderBy: { col: string; asc: boolean } | null = null;
    const obj: any = {
      select(c?: string) { if (mode !== "select") wantRows = true; else cols = String(c ?? ""); return obj; },
      insert(d: any) { mode = "insert"; payload = d; return obj; },
      upsert(d: any, o: any) { mode = "upsert"; payload = d; upsertOpts = o ?? {}; return obj; },
      update(d: any) { mode = "update"; payload = d; return obj; },
      delete() { mode = "delete"; return obj; },
      eq(c: string, v: any) { filters.push((r) => r[c] === v); return obj; },
      neq(c: string, v: any) { filters.push((r) => r[c] !== v); return obj; },
      in(c: string, vs: any[]) { const s = new Set(vs); filters.push((r) => s.has(r[c])); return obj; },
      is(c: string, v: any) { filters.push((r) => (v === null ? r[c] == null : r[c] === v)); return obj; },
      gte(c: string, v: any) { filters.push((r) => r[c] != null && String(r[c]) >= String(v)); return obj; },
      lte(c: string, v: any) { filters.push((r) => r[c] != null && String(r[c]) <= String(v)); return obj; },
      order(col: string, o?: any) { orderBy = { col, asc: o?.ascending !== false }; return obj; },
      limit(n: number) { limitN = n; return obj; },
      maybeSingle() { single = true; return run(); },
      single() { single = true; return run(); },
      then(f: any, r: any) { return run().then(f, r); },
    };
    const err = (message: string, code?: string) => ({ data: null, error: { message, code } });
    async function run(): Promise<any> {
      await new Promise((r) => setTimeout(r, 1));
      if (opts.absent?.has(table)) return err(`relation "public.${table}" does not exist`, "42P01");
      if (mode === "select" && opts.failReads?.has(table)) return err(`${table} unavailable`, "57014");
      if (mode !== "select" && opts.failWrites?.has(`${table}:${mode}`)) return err(`${table} ${mode} failed`, "57014");
      // 3672 not applied: the column is not there, for a read and for a write.
      if (table === "memory_items" && !opts.itemVisibility) {
        if (mode === "select" && /\bvisibility\b/.test(cols)) return err("column memory_items.visibility does not exist", "42703");
        const keys = mode === "select" || mode === "delete" ? [] : Object.keys(Array.isArray(payload) ? (payload[0] ?? {}) : (payload ?? {}));
        if (keys.includes("visibility")) return err("Could not find the 'visibility' column of 'memory_items' in the schema cache", "PGRST204");
      }
      if (mode !== "select") writes.push({ table, mode, payload });
      const all = (store[table] ??= []);
      if (mode === "insert" || mode === "upsert") {
        const incoming = (Array.isArray(payload) ? payload : [payload]).map((r: any) => ({ ...r }));
        const written: any[] = [];
        for (const r of incoming) {
          if (table === "memory_episodes") {
            const dup = all.find((x) => x.user_id === r.user_id && x.detection_reason === r.detection_reason
              && x.detector_version === r.detector_version && x.detection_digest === r.detection_digest && r.detection_digest != null);
            if (dup) return err("duplicate key value violates unique constraint \"memory_episodes_replay_key\"", "23505");
            Object.assign(r, { id: newId(), state: r.state ?? "candidate", significance: r.significance ?? null, significance_basis: r.significance_basis ?? null,
              state_changed_at: "2026-10-05T00:00:00.000Z", merged_into_id: null, sensitivity: "normal",
              retention_class: "trip_context", created_at: `2026-10-05T00:00:${String(gen % 60).padStart(2, "0")}.000Z`, updated_at: "2026-10-05T00:00:00.000Z" });
          } else if (table === "memory_evidence") {
            const dup = all.find((x) => x.episode_id === r.episode_id && x.source_table === r.source_table
              && x.source_id === r.source_id && x.truth_level === r.truth_level);
            if (dup) {
              if (mode === "upsert" && upsertOpts.ignoreDuplicates) continue;
              return err("duplicate key value violates unique constraint \"memory_evidence_dedupe_idx\"", "23505");
            }
            Object.assign(r, { id: newId(), recorded_at: dbNow() });
          } else if (table === TABLE) {
            // 3806's guard trigger fires BEFORE the conflict check, on every row.
            const mem = store.memories.find((x) => x.id === r.memory_id);
            if (!mem || mem.owner_id !== r.owner_id) return err("memory_convergence_proposals: the Memory is not this owner's", "23514");
            const ph = store.media_assets.find((x) => x.id === r.media_asset_id);
            if (!ph || ph.owner_user_id !== r.owner_id) return err("memory_convergence_proposals: the photo is not this owner's", "23514");
            Object.assign(r, { state: r.state ?? "proposed", proposed_at: r.proposed_at ?? dbNow(), decided_at: r.decided_at ?? null });
            if ((r.state === "proposed") !== (r.decided_at == null)) return err("violates check constraint \"memory_convergence_proposals_decision_stamped\"", "23514");
            const dup = all.find((x) => x.owner_id === r.owner_id && x.memory_id === r.memory_id && x.media_asset_id === r.media_asset_id);
            if (dup) {
              if (mode === "upsert" && upsertOpts.ignoreDuplicates) continue;
              return err("duplicate key value violates unique constraint \"memory_convergence_proposals_pkey\"", "23505");
            }
          } else {
            if (r.id != null && all.some((x) => x.id === r.id)) return err(`duplicate key value violates unique constraint "${table}_pkey"`, "23505");
            r.id = r.id ?? newId();
            if (table === "memory_items" && opts.itemVisibility && !("visibility" in r)) r.visibility = null;
          }
          all.push(r);
          written.push(r);
        }
        if (!wantRows) return { data: null, error: null };
        return { data: single ? written[0] ?? null : written, error: null };
      }
      if (mode === "update" && opts.beforeUpdate) opts.beforeUpdate(table, store);
      let matched = all.filter((r) => filters.every((f) => f(r)));
      if (mode === "delete") {
        store[table] = all.filter((r) => !matched.includes(r));
        return { data: wantRows ? matched.map((r) => ({ ...r })) : null, error: null };
      }
      if (mode === "update") {
        for (const r of matched) {
          const next = { ...r, ...payload };
          if (table === TABLE) {
            if (r.state !== "proposed" && (next.state !== r.state || next.decided_at !== r.decided_at)) return err(`memory_convergence_proposals: a ${r.state} proposal is decided — a decision is final`, "23514");
            if ((next.state === "proposed") !== (next.decided_at == null)) return err("violates check constraint \"memory_convergence_proposals_decision_stamped\"", "23514");
          }
          if (table === "memory_episodes" && !["candidate", "rejected", "deleted"].includes(next.state)
            && (next.significance == null || next.significance_basis == null)) {
            return err("new row violates check constraint \"memory_episodes_eligibility_check\"", "23514");
          }
        }
        for (const r of matched) Object.assign(r, payload);
        if (!wantRows) return { data: null, error: null };
        return { data: matched.map((r) => ({ ...r })), error: null };
      }
      if (orderBy) {
        const { col, asc } = orderBy;
        matched = [...matched].sort((x, y) => (String(x[col] ?? "") < String(y[col] ?? "") ? -1 : String(x[col] ?? "") > String(y[col] ?? "") ? 1 : 0) * (asc ? 1 : -1));
      }
      if (limitN != null) matched = matched.slice(0, limitN);
      if (single) return { data: matched[0] ? { ...matched[0] } : null, error: null };
      return { data: matched.map((r) => ({ ...r })), error: null };
    }
    return obj;
  }
  /** 2711's memory_kernel_execute, for ADD_MEDIA: receipt on (actor, key); its own item id; no photo audience. */
  async function rpc(fn: string, args: { p_command: any }) {
    await new Promise((r) => setTimeout(r, 1));
    if (!opts.kernel || fn !== "memory_kernel_execute") return { data: null, error: { message: "rpc not modelled" } };
    const c = args.p_command;
    const key = `${c.actor_user_id}\u0000${c.idempotency_key}`;
    const had = receipts.get(key);
    if (had) return { data: { ok: true, duplicate: true, memory_id: c.memory_id, event_id: had.event_id, event_type: "memory.corrected", result: had.result, contract_version: 1 }, error: null };
    if (c.type !== "ADD_MEDIA") return { data: { ok: false, reason: "MEMORY_KERNEL_UNAVAILABLE", contract_version: 1 }, error: null };
    const mem = store.memories.find((x) => x.id === c.memory_id && x.state !== "deleted");
    if (!mem || mem.owner_id !== c.actor_user_id) return { data: { ok: false, reason: "MEMORY_AUTH_NOT_OWNER", contract_version: 1 }, error: null };
    const w = c.payload.write;
    const item: any = { id: newId(), memory_id: mem.id, media_url: w.media_url, media_type: w.media_type ?? "image/jpeg", caption: w.caption ?? null, position: w.position ?? 0 };
    if (opts.itemVisibility) item.visibility = null;
    store.memory_items.push(item);
    const event_id = newId();
    receipts.set(key, { event_id, result: { ...item } });
    return { data: { ok: true, duplicate: false, memory_id: mem.id, event_id, event_type: "memory.corrected", result: { ...item }, contract_version: 1 }, error: null };
  }
  return {
    from: (t: string) => chain(t),
    rpc,
    writes,
    auth: { getUser: async (token: string) => ({ data: { user: { id: token } }, error: null }) },
  };
}

interface App { base: string; store: Record<string, any[]>; client: ReturnType<typeof makeClient>; receipts: Map<string, any>; close: () => Promise<void> }

async function start(opts: FakeOpts & { mutate?: (s: Record<string, any[]>) => void } = {}): Promise<App> {
  resetHighlightSchemaMemo();
  const store = seed();
  if (opts.kernel) store.feature_flags.push({ flag: "memory_kernel_enabled", enabled: true });
  opts.mutate?.(store);
  const receipts = new Map<string, any>();
  const client = makeClient(store, opts, receipts);
  _setTestClient(client as any, true);
  const app = express();
  app.use(express.json());
  app.use((req: any, _r: any, n: any) => { req.log = { error: () => {}, info: () => {}, warn: () => {} }; n(); });
  app.use("/api", memoryCandidatesRouter);
  const srv = http.createServer(app);
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
  const { port } = srv.address() as { port: number };
  return { base: `http://127.0.0.1:${port}`, store, client, receipts, close: () => new Promise<void>((r) => { srv.closeAllConnections(); srv.close(() => r()); }) };
}

/** Swap the client the routes use (same store, same kernel receipts), e.g. to make one write fail. */
function reclient(app: App, opts: FakeOpts): void {
  resetHighlightSchemaMemo();
  app.client = makeClient(app.store, opts, app.receipts);
  _setTestClient(app.client as any, true);
}

async function call(app: App, method: string, path: string, actor: string, body?: unknown) {
  const res = await fetch(app.base + path, {
    method,
    headers: { Authorization: `Bearer ${actor}`, "Content-Type": "application/json", connection: "close" },
    body: body === undefined ? (method === "POST" ? "{}" : undefined) : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: any = null; try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
  return { status: res.status, body: parsed };
}

const detect = (app: App, tripId = TRIP, actor = OWNER) => call(app, "POST", "/api/me/memory-candidates/detect", actor, { tripId });
const inbox = (app: App, actor = OWNER) => call(app, "GET", "/api/me/memory-candidates", actor);
const keep = (app: App, memoryId: string, assetIds: string[], extra: Record<string, unknown> = {}, actor = OWNER) =>
  call(app, "POST", `/api/me/memory-convergence/${memoryId}/keep`, actor, { assetIds, ...extra });
const dismiss = (app: App, memoryId: string, assetIds: string[], actor = OWNER) =>
  call(app, "POST", `/api/me/memory-convergence/${memoryId}/dismiss`, actor, { assetIds });

const proposals = (app: App) => app.store[TABLE] ?? [];
const proposal = (app: App, memoryId: string, n: number) => proposals(app).find((p) => p.memory_id === memoryId && p.media_asset_id === a(n));
const itemsOf = (app: App, memoryId: string) => app.store.memory_items.filter((i) => i.memory_id === memoryId);
const evidenceFor = (app: App, n: number) => app.store.memory_evidence.filter((v) => v.source_table === "media_assets" && v.source_id === a(n));
const eveningEpisodes = (app: App) => app.store.memory_episodes.filter((e) => String(e.started_at) < "2026-03-03T00:00:00.000Z");

let app: App | null = null;
beforeEach(() => { _resetMemoryKernelMetrics(); });
afterEach(async () => { if (app) { await app.close(); app = null; } });

describe("H180 detection — a capture inside a Memory the owner already has is proposed to it, not made a second candidate", () => {
  it("Memory M 19:00–22:00; device B's 20:15 and 21:30 ⇒ one proposal each for M, and NO new candidate for that evening", async () => {
    app = await start();
    const r = await detect(app);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.report.convergence, { state: "ready", capturesMatched: 2, proposalsAdded: 2, memories: 1 });
    assert.deepEqual(proposals(app).map((p) => [p.owner_id, p.memory_id, p.media_asset_id, p.basis, p.state, p.decided_at]).sort(), [
      [OWNER, M, a(2), "memory_window", "proposed", null],
      [OWNER, M, a(3), "memory_window", "proposed", null],
    ]);
    assert.equal(eveningEpisodes(app).length, 0, "the evening M already holds is not proposed a second time as a candidate");
    assert.equal(evidenceFor(app, 2).length + evidenceFor(app, 3).length, 0, "they are not evidence of a new episode either");
    assert.equal(app.store.memory_episodes.length, 1, "the next day's lunch is still a candidate of its own");
    assert.equal(itemsOf(app, M).length, 1, "NOTHING is attached by detection");
  });

  it("the inbox lists them under the Memory, with its audience and the audience a kept photo will have — candidates stay separate", async () => {
    app = await start({ mutate: (s) => { s.memories[0].visibility = "friends_only"; } });
    await detect(app);
    const r = await inbox(app);
    assert.equal(r.status, 200);
    assert.equal(r.body.convergence.state, "ready");
    assert.equal(r.body.convergence.groups.length, 1);
    const g = r.body.convergence.groups[0];
    assert.deepEqual([g.memoryId, g.title, g.visibility, g.attachAudience, g.basis], [M, "Fado night", "friends_only", "memory", "memory_window"]);
    assert.deepEqual(g.photos.map((p: any) => [p.assetId, p.previewUrl, p.state]), [[a(2), url(2), "proposed"], [a(3), url(3), "proposed"]]);
    assert.ok(r.body.candidates.every((c: any) => c.startedAt >= "2026-03-03"), "no candidate for M's evening");
  });

  it("a re-run proposes nothing new and writes nothing", async () => {
    app = await start();
    await detect(app);
    const before = JSON.stringify(app.store);
    const r = await detect(app);
    assert.equal(r.body.report.convergence.proposalsAdded, 0);
    assert.equal(r.body.report.convergence.capturesMatched, 2);
    assert.equal(JSON.stringify(app.store), before);
  });

  it("ANOTHER PERSON's Memory on the same trip, same window, is never proposed to — the owner's photos stay their own candidate", async () => {
    app = await start({
      mutate: (s) => {
        s.memories = [memory(THEIRS, { owner_id: OTHER, title: "theirs" })];
        s.memory_items = [];
        s.trip_members.push({ trip_id: TRIP, user_id: OTHER, role: "member", status: "accepted" });
      },
    });
    const r = await detect(app);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(proposals(app).length, 0);
    assert.equal(r.body.report.convergence.capturesMatched, 0);
    assert.equal(eveningEpisodes(app).length, 1, "the evening is the owner's own candidate");
    const theirs = await inbox(app, OTHER);
    assert.deepEqual(theirs.body.convergence, { state: "ready", groups: [] });
  });

  it("a Memory on ANOTHER trip is not proposed to, even when the instant is inside its window", async () => {
    app = await start({ mutate: (s) => { s.memories[0].trip_id = SIDE_TRIP; } });
    const r = await detect(app, TRIP);
    assert.equal(r.status, 200);
    assert.equal(proposals(app).length, 0, "M is on the side trip; looking through the main trip proposes nothing to it");
    assert.equal(eveningEpisodes(app).length, 1);
    const side = await detect(app, SIDE_TRIP);
    assert.equal(side.status, 200);
    assert.deepEqual(proposals(app).map((p) => p.media_asset_id).sort(), [a(2), a(3)], "looking through M's own trip does propose them");
  });

  it("a Memory that is not published (archived) takes no proposals", async () => {
    app = await start({ mutate: (s) => { s.memories[0].state = "archived"; } });
    await detect(app);
    assert.equal(proposals(app).length, 0);
    assert.equal(eveningEpisodes(app).length, 1);
  });

  it("a window longer than 24 h is not evidence of one moment: nothing converges onto it", async () => {
    app = await start({ mutate: (s) => { Object.assign(s.memories[0], { starts_at: "2026-03-01T00:00:00.000Z", ends_at: "2026-03-04T00:00:00.000Z" }); } });
    await detect(app);
    assert.equal(proposals(app).length, 0);
    assert.equal(eveningEpisodes(app).length, 1);
  });

  it("no stated window: the capture span of the Memory's OWN photos is its window, inclusive at both ends", async () => {
    app = await start({
      mutate: (s) => {
        Object.assign(s.memories[0], { starts_at: null, ends_at: null });
        s.media_assets.push(media(6, "2026-03-02T21:00:00.000Z"));
        s.memory_items.push({ id: "91000000-0000-4000-8000-000000000006", memory_id: M, media_url: url(6), media_type: "image/jpeg", caption: null, position: 1 });
        s.media_assets.push(media(7, "2026-03-02T19:05:00.000Z", { public_url: url(7) })); // the span's own first instant
      },
    });
    await detect(app);
    assert.deepEqual(proposals(app).map((p) => p.media_asset_id).sort(), [a(2), a(7)], "20:15 and 19:05 are inside 19:05–21:00; 21:30 is not");
  });

  it("a capture inside two of the owner's Memories is proposed to BOTH — the owner decides, the system never picks", async () => {
    app = await start({ mutate: (s) => { s.memories.push(memory(M2, { title: "Walk home", starts_at: "2026-03-02T20:00:00.000Z", ends_at: "2026-03-02T23:00:00.000Z" })); } });
    const r = await detect(app);
    assert.deepEqual(proposals(app).map((p) => `${p.memory_id === M ? "M" : "M2"}:${p.media_asset_id === a(2) ? 2 : 3}`).sort(), ["M2:2", "M2:3", "M:2", "M:3"]);
    assert.deepEqual([r.body.report.convergence.capturesMatched, r.body.report.convergence.memories], [2, 2]);
  });

  it("3806 NOT DEPLOYED: detection is exactly as before (a candidate), the inbox says not_deployed, Keep is feature_disabled", async () => {
    app = await start({ absent: new Set([TABLE]) });
    const r = await detect(app);
    assert.equal(r.status, 200);
    assert.equal(r.body.report.convergence.state, "not_deployed");
    assert.equal(eveningEpisodes(app).length, 1);
    const list = await inbox(app);
    assert.equal(list.status, 200);
    assert.deepEqual(list.body.convergence, { state: "not_deployed" });
    const k = await keep(app, M, [a(2)]);
    assert.deepEqual([k.status, k.body.error], [404, "feature_disabled"]);
  });

  it("3806 UNREADABLE: detection refuses (503) and writes nothing — never a duplicate candidate it could not rule out; the inbox says unavailable", async () => {
    app = await start({ failReads: new Set([TABLE]) });
    const r = await detect(app);
    assert.equal(r.status, 503);
    assert.equal(app.store.memory_episodes.length + app.store.memory_evidence.length + proposals(app).length, 0);
    const list = await inbox(app);
    assert.equal(list.status, 200);
    assert.deepEqual(list.body.convergence, { state: "unavailable" });
  });

  it("a proposal write that fails is 503, and no candidate is written for those photos", async () => {
    app = await start({ failWrites: new Set([`${TABLE}:upsert`]) });
    const r = await detect(app);
    assert.equal(r.status, 503);
    assert.equal(eveningEpisodes(app).length, 0);
  });
});

describe("H180 Keep — only the owner's Keep attaches, through §17 ADD_MEDIA, once", () => {
  it("Keep onto an only_me Memory attaches each photo once, in capture order after the photos already there, and the inbox empties", async () => {
    app = await start();
    await detect(app);
    const r = await keep(app, M, [a(3), a(2)]);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.kept.map((k: any) => [k.assetId, k.itemAudience]), [[a(2), "memory"], [a(3), "memory"]]);
    const items = itemsOf(app, M).sort((x, y) => x.position - y.position);
    assert.deepEqual(items.map((i) => [i.media_url, i.position]), [[url(1), 0], [url(2), 1], [url(3), 2]]);
    assert.equal(items[1].id, candidateItemId(M, a(2)), "the item id is derived from (Memory, photo)");
    assert.deepEqual([proposal(app, M, 2).state, proposal(app, M, 3).state], ["kept", "kept"]);
    assert.ok(proposal(app, M, 2).decided_at);
    assert.deepEqual((await inbox(app)).body.convergence.groups, []);
  });

  it("KEEP TWICE ⇒ ONE item per photo (a second tap, a retry)", async () => {
    app = await start();
    await detect(app);
    assert.equal((await keep(app, M, [a(2), a(3)])).status, 200);
    const again = await keep(app, M, [a(2), a(3)]);
    assert.equal(again.status, 200, JSON.stringify(again.body));
    assert.deepEqual(again.body.kept.map((k: any) => k.itemAudience), ["unchanged", "unchanged"]);
    assert.equal(itemsOf(app, M).length, 3, "the original photo plus exactly two");
  });

  it("two Keeps AT ONCE ⇒ one item per photo", async () => {
    app = await start();
    await detect(app);
    const [r1, r2] = await Promise.all([keep(app, M, [a(2), a(3)]), keep(app, M, [a(2), a(3)])]);
    assert.deepEqual([r1.status, r2.status], [200, 200], JSON.stringify([r1.body, r2.body]));
    assert.equal(itemsOf(app, M).length, 3);
  });

  it("kernel ON: ADD_MEDIA goes through the kernel; two Keeps at once are ONE item", async () => {
    app = await start({ kernel: true });
    await detect(app);
    const [r1, r2] = await Promise.all([keep(app, M, [a(2)]), keep(app, M, [a(2)])]);
    assert.deepEqual([r1.status, r2.status], [200, 200], JSON.stringify([r1.body, r2.body]));
    assert.equal(app.store.memory_items.filter((i) => i.media_url === url(2)).length, 1);
    assert.deepEqual([...app.receipts.keys()].map((k) => k.split("\u0000")[1]), [convergenceItemKey(M, a(2))]);
  });

  it("kernel ON: the key is DERIVED from (Memory, photo) — a retry that cannot see the first item still reaches the same command, and the receipt inserts nothing", async () => {
    app = await start({ kernel: true });
    await detect(app);
    const first = await keep(app, M, [a(2)]);
    assert.equal(first.status, 200);
    // The URL check is the first line of defence; take it away to test the second.
    const firstItem = app.store.memory_items.find((i) => i.media_url === url(2));
    app.store.memory_items = app.store.memory_items.filter((i) => i !== firstItem);
    const again = await keep(app, M, [a(2)]);
    assert.equal(again.status, 200, JSON.stringify(again.body));
    assert.equal(app.receipts.size, 1, "one command, by its key");
    assert.equal(app.store.memory_items.filter((i) => i.media_url === url(2)).length, 0, "the receipt answered the original result; nothing was inserted");
    assert.equal(again.body.kept[0].itemId, firstItem.id);
  });

  it("KEEP ONTO A PUBLIC MEMORY WITHOUT ECHOING ITS AUDIENCE ⇒ 409 with the current audience, and nothing is written", async () => {
    app = await start({ mutate: (s) => { s.memories[0].visibility = "public"; } });
    await detect(app);
    const before = JSON.stringify([app.store.memory_items, proposals(app)]);
    const r = await keep(app, M, [a(2)]);
    assert.equal(r.status, 409);
    assert.deepEqual([r.body.reason, r.body.currentAudience], ["audience_unconfirmed", "public"]);
    assert.equal(JSON.stringify([app.store.memory_items, proposals(app)]), before, "no item, no claim");
    const ok = await keep(app, M, [a(2)], { confirmAudience: "public" });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(itemsOf(app, M).length, 2);
  });

  it("a STALE echo (the client showed Friends; the Memory is now Public) ⇒ 409 — and so is a wrong echo on an only_me Memory", async () => {
    app = await start({ mutate: (s) => { s.memories[0].visibility = "public"; } });
    await detect(app);
    const r = await keep(app, M, [a(2)], { confirmAudience: "friends_only" });
    assert.deepEqual([r.status, r.body.reason, r.body.currentAudience], [409, "audience_unconfirmed", "public"]);
    app.store.memories[0].visibility = "only_me";
    const wrong = await keep(app, M, [a(2)], { confirmAudience: "public" });
    assert.deepEqual([wrong.status, wrong.body.currentAudience], [409, "only_me"]);
    assert.equal(itemsOf(app, M).length, 1);
  });

  it("3672 DEPLOYED: a kept photo is written only_me IN THE INSERT — there is no moment it has the Memory's audience", async () => {
    app = await start({ itemVisibility: true, mutate: (s) => { s.memories[0].visibility = "friends_only"; } });
    await detect(app);
    const listed = await inbox(app);
    assert.equal(listed.body.convergence.groups[0].attachAudience, "only_me");
    const r = await keep(app, M, [a(2)], { confirmAudience: "friends_only" });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.kept[0].itemAudience, "only_me");
    const inserts = app.client.writes.filter((w) => w.table === "memory_items" && w.mode === "insert");
    assert.deepEqual(inserts.map((w) => w.payload.visibility), ["only_me"]);
    assert.equal(app.client.writes.filter((w) => w.table === "memory_items" && w.mode === "update").length, 0);
    assert.equal(itemsOf(app, M).find((i) => i.media_url === url(2)).visibility, "only_me");
  });

  it("3672 deployed, kernel ON: the kernel takes no photo audience, so the photo is narrowed straight after", async () => {
    app = await start({ itemVisibility: true, kernel: true });
    await detect(app);
    const r = await keep(app, M, [a(2)]);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.kept[0].itemAudience, "only_me");
    assert.equal(itemsOf(app, M).find((i) => i.media_url === url(2)).visibility, "only_me");
  });

  it("…and when that narrowing fails, the answer says the photo has the Memory's (confirmed) audience — never a silent only_me", async () => {
    app = await start({ itemVisibility: true, kernel: true, failWrites: new Set(["memory_items:update"]), mutate: (s) => { s.memories[0].visibility = "friends_only"; } });
    await detect(app);
    const r = await keep(app, M, [a(2)], { confirmAudience: "friends_only" });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.kept[0].itemAudience, "memory");
    assert.equal(itemsOf(app, M).find((i) => i.media_url === url(2)).visibility, null);
  });

  it("an attach that fails after the claim leaves an INTERRUPTED Keep in the inbox; Keep again finishes it with one item", async () => {
    app = await start();
    await detect(app);
    reclient(app, { failWrites: new Set(["memory_items:insert"]) });
    const failed = await keep(app, M, [a(2)]);
    assert.equal(failed.status, 503);
    assert.equal(proposal(app, M, 2).state, "kept", "the claim held");
    reclient(app, {});
    const listed = await inbox(app);
    assert.deepEqual(listed.body.convergence.groups[0].photos.map((p: any) => [p.assetId, p.state]), [[a(2), "interrupted"], [a(3), "proposed"]]);
    const done = await keep(app, M, [a(2)]);
    assert.equal(done.status, 200, JSON.stringify(done.body));
    assert.equal(app.store.memory_items.filter((i) => i.media_url === url(2)).length, 1);
  });

  it("a photo deleted after it was proposed is neither listed nor attached", async () => {
    app = await start();
    await detect(app);
    Object.assign(app.store.media_assets.find((m) => m.id === a(2)), { deleted_at: "2026-10-05T00:00:00.000Z", processing_status: "removed", moderation_status: "owner_deleted" });
    const listed = await inbox(app);
    assert.deepEqual(listed.body.convergence.groups[0].photos.map((p: any) => p.assetId), [a(3)]);
    const r = await keep(app, M, [a(2)]);
    assert.deepEqual([r.status, r.body.reason], [409, "nothing_to_keep"]);
    assert.equal(itemsOf(app, M).length, 1);
  });

  it("a photo that was not proposed for this Memory is not attached by naming it", async () => {
    app = await start();
    await detect(app);
    const r = await keep(app, M, [a(4)]);
    assert.deepEqual([r.status, r.body.reason], [409, "nothing_to_keep"]);
    assert.equal(itemsOf(app, M).length, 1);
  });

  it("another person cannot keep or dismiss the owner's proposals: 404 and nothing changes", async () => {
    app = await start();
    await detect(app);
    const before = JSON.stringify(app.store);
    assert.equal((await keep(app, M, [a(2)], {}, OTHER)).status, 404);
    assert.equal((await dismiss(app, M, [a(2)], OTHER)).status, 404);
    assert.equal(JSON.stringify(app.store), before);
  });

  it("a Memory archived after the proposal takes no photo (409)", async () => {
    app = await start();
    await detect(app);
    app.store.memories[0].state = "archived";
    const r = await keep(app, M, [a(2)]);
    assert.deepEqual([r.status, r.body.reason], [409, "memory_not_published"]);
    assert.equal(itemsOf(app, M).length, 1);
  });

  it("malformed requests are 400", async () => {
    app = await start();
    assert.equal((await keep(app, M, [])).status, 400);
    assert.equal((await keep(app, M, ["nope"])).status, 400);
    assert.equal((await keep(app, M, [a(2)], { confirmAudience: 7 })).status, 400);
    assert.equal((await keep(app, "nope", [a(2)])).status, 400);
    assert.equal((await dismiss(app, M, Array.from({ length: 101 }, (_, i) => a(100 + i)))).status, 400);
  });
});

describe("H180 Dismiss — the durable negative", () => {
  it("A DISMISSED PHOTO IS NEVER PROPOSED AGAIN — nor resurfaced as a fresh candidate — however often detection re-runs", async () => {
    app = await start();
    await detect(app);
    const d = await dismiss(app, M, [a(2)]);
    assert.equal(d.status, 200, JSON.stringify(d.body));
    assert.deepEqual(d.body.dismissed, [a(2)]);
    for (let i = 0; i < 2; i += 1) {
      const r = await detect(app);
      assert.equal(r.status, 200);
      assert.equal(r.body.report.convergence.proposalsAdded, 0);
    }
    assert.equal(proposal(app, M, 2).state, "dismissed");
    assert.equal(proposals(app).filter((p) => p.media_asset_id === a(2)).length, 1);
    assert.equal(evidenceFor(app, 2).length, 0, "not evidence of a new candidate either");
    assert.equal(eveningEpisodes(app).length, 0);
    const listed = await inbox(app);
    assert.deepEqual(listed.body.convergence.groups[0].photos.map((p: any) => p.assetId), [a(3)]);
    const k = await keep(app, M, [a(2)]);
    assert.deepEqual([k.status, k.body.reason], [409, "nothing_to_keep"], "a dismissed photo cannot be kept through this route");
  });

  it("dismissing again is a replay; dismissing a photo that was never proposed is 409", async () => {
    app = await start();
    await detect(app);
    await dismiss(app, M, [a(2)]);
    const again = await dismiss(app, M, [a(2)]);
    assert.deepEqual([again.status, again.body.alreadyDismissed], [200, [a(2)]]);
    const never = await dismiss(app, M, [a(4)]);
    assert.deepEqual([never.status, never.body.reason], [409, "nothing_to_dismiss"]);
  });

  it("ONE DECISION WINS: a Dismiss that commits before Keep's claim makes the Keep attach nothing", async () => {
    let raced = false;
    app = await start({
      beforeUpdate: (table, st) => {
        if (table !== TABLE || raced) return;
        raced = true;
        const p = st[TABLE].find((x) => x.media_asset_id === a(2));
        Object.assign(p, { state: "dismissed", decided_at: "2026-10-05T00:00:00.000Z" });
      },
    });
    await detect(app);
    const r = await keep(app, M, [a(2)]);
    assert.deepEqual([r.status, r.body.reason], [409, "nothing_to_keep"]);
    assert.equal(itemsOf(app, M).length, 1, "no photo behind a dismissal");
  });

  it("a kept photo cannot be dismissed (409): remove it from the Memory instead", async () => {
    app = await start();
    await detect(app);
    await keep(app, M, [a(2)]);
    const d = await dismiss(app, M, [a(2)]);
    assert.deepEqual([d.status, d.body.reason], [409, "nothing_to_dismiss"]);
    assert.equal(proposal(app, M, 2).state, "kept");
  });
});

describe("H180 late captures of a KEPT episode", () => {
  /** No hand-made Memory: the owner keeps a detected evening, then device B's photo arrives. */
  async function keptEvening(a0: App) {
    a0.store.memories = [];
    a0.store.memory_items = [];
    await detect(a0);
    const ep = a0.store.memory_episodes.find((e) => e.started_at === "2026-03-02T19:05:00.000Z");
    const kept = await call(a0, "POST", `/api/me/memory-candidates/${ep.id}/confirm`, OWNER, { title: "Fado night" });
    assert.equal(kept.status, 200, JSON.stringify(kept.body));
    return { ep, memoryId: kept.body.memoryId as string };
  }

  it("a photo that joins the kept episode is PROPOSED to its Memory (basis confirmed_episode) — not attached, not a new candidate", async () => {
    app = await start();
    const { ep, memoryId } = await keptEvening(app);
    assert.equal(itemsOf(app, memoryId).length, 3);
    app.store.media_assets.push(media(8, "2026-03-02T20:50:00.000Z"));
    const episodesBefore = app.store.memory_episodes.length;
    const r = await detect(app);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(app.store.memory_episodes.length, episodesBefore, "no second episode for the evening");
    assert.ok(evidenceFor(app, 8).some((v) => v.episode_id === ep.id), "the capture is evidence on the kept episode (H179)");
    assert.deepEqual(proposals(app).map((p) => [p.memory_id, p.media_asset_id, p.basis, p.state]), [[memoryId, a(8), "confirmed_episode", "proposed"]]);
    assert.equal(itemsOf(app, memoryId).length, 3, "not attached by detection");
    const listed = await inbox(app);
    assert.deepEqual(listed.body.convergence.groups.map((g: any) => [g.memoryId, g.basis, g.photos.map((p: any) => p.assetId)]), [[memoryId, "confirmed_episode", [a(8)]]]);
    const k = await keep(app, memoryId, [a(8)]);
    assert.equal(k.status, 200, JSON.stringify(k.body));
    assert.equal(itemsOf(app, memoryId).length, 4);
  });

  it("A RETRIED KEEP OF THE EPISODE NO LONGER ATTACHES THE LATE PHOTO the owner was never shown", async () => {
    app = await start();
    const { ep, memoryId } = await keptEvening(app);
    app.store.media_assets.push(media(8, "2026-03-02T20:50:00.000Z"));
    await detect(app);
    const replay = await call(app, "POST", `/api/me/memory-candidates/${ep.id}/confirm`, OWNER, {});
    assert.equal(replay.status, 200, JSON.stringify(replay.body));
    assert.equal(replay.body.mediaAttached, 0);
    assert.ok(!itemsOf(app, memoryId).some((i) => i.media_url === url(8)), "the late photo waits for the owner's own Keep");
    assert.equal(proposal(app, memoryId, 8).state, "proposed");
  });

  it("a dismissed late photo stays out on every later detection and every retried Keep", async () => {
    app = await start();
    const { ep, memoryId } = await keptEvening(app);
    app.store.media_assets.push(media(8, "2026-03-02T20:50:00.000Z"));
    await detect(app);
    assert.equal((await dismiss(app, memoryId, [a(8)])).status, 200);
    await detect(app);
    await call(app, "POST", `/api/me/memory-candidates/${ep.id}/confirm`, OWNER, {});
    assert.equal(proposal(app, memoryId, 8).state, "dismissed");
    assert.ok(!itemsOf(app, memoryId).some((i) => i.media_url === url(8)));
  });
});

describe("H180 §21 — a deleted Memory takes its proposals and dismissals with it", () => {
  it("RAW_EVIDENCE_PURGED purges every row about the Memory (proposed and dismissed); the inbox and Keep forget it", async () => {
    app = await start();
    await detect(app);
    await dismiss(app, M, [a(3)]);
    app.store.memories[0].state = "deleted";
    const report = await runMemoryDeletionLifecycle(app.client as any, {
      memoryId: M, ownerId: OWNER, actorUserId: OWNER,
      previous: { visibility: "only_me", state: "published", trip_id: TRIP },
      now: new Date("2026-10-05T00:00:00.000Z"),
    });
    const step = report.steps.find((s) => s.step === "RAW_EVIDENCE_PURGED")!;
    assert.equal(step.outcome, "done", JSON.stringify(step));
    assert.equal(step.facts.convergencePurged, 2);
    assert.equal(proposals(app).length, 0);
    assert.deepEqual((await inbox(app)).body.convergence.groups, []);
    assert.equal((await keep(app, M, [a(2)])).status, 404);
  });

  it("a purge that fails is a retryable failure of that state, named — never `done`", async () => {
    app = await start();
    await detect(app);
    app.store.memories[0].state = "deleted";
    reclient(app, { failWrites: new Set([`${TABLE}:delete`]) });
    const report = await runMemoryDeletionLifecycle(app.client as any, {
      memoryId: M, ownerId: OWNER, actorUserId: OWNER,
      previous: { visibility: "only_me", state: "published", trip_id: TRIP },
    });
    const step = report.steps.find((s) => s.step === "RAW_EVIDENCE_PURGED")!;
    assert.equal(step.outcome, "failed");
    assert.match(step.detail, /memory_convergence_proposals purge/);
    assert.equal(proposals(app).length, 2);
  });
});

describe("H180 pure rules", () => {
  const T = (s: string) => `2026-03-02T${s}:00.000Z`;
  it("memoryWindow: the stated window when both ends are set (either order), else the photos' span; ≥ 2 instants; ≤ 24 h", () => {
    assert.deepEqual(memoryWindow({ startsAt: T("19:00"), endsAt: T("22:00"), itemCaptureTimes: [T("08:00")] }), { from: Date.parse(T("19:00")), to: Date.parse(T("22:00")) });
    assert.deepEqual(memoryWindow({ startsAt: T("22:00"), endsAt: T("19:00"), itemCaptureTimes: [] }), { from: Date.parse(T("19:00")), to: Date.parse(T("22:00")) });
    assert.deepEqual(memoryWindow({ startsAt: T("19:00"), endsAt: null, itemCaptureTimes: [T("20:00"), T("19:30")] }), { from: Date.parse(T("19:30")), to: Date.parse(T("20:00")) });
    assert.equal(memoryWindow({ startsAt: T("19:00"), endsAt: null, itemCaptureTimes: [] }), null, "a start alone is a point, not a window");
    assert.equal(memoryWindow({ startsAt: null, endsAt: null, itemCaptureTimes: [T("19:00")] }), null, "one photo is a point, not a window");
    assert.equal(memoryWindow({ startsAt: null, endsAt: null, itemCaptureTimes: ["not a time", T("19:00")] }), null);
    const day = Date.parse(T("00:00"));
    assert.ok(memoryWindow({ startsAt: new Date(day).toISOString(), endsAt: new Date(day + MAX_CONVERGENCE_WINDOW_MS).toISOString(), itemCaptureTimes: [] }), "exactly 24 h is one moment");
    assert.equal(memoryWindow({ startsAt: new Date(day).toISOString(), endsAt: new Date(day + MAX_CONVERGENCE_WINDOW_MS + 1).toISOString(), itemCaptureTimes: [] }), null);
  });

  it("windowsContaining: inclusive at both ends; an undated capture is in no window", () => {
    const w = [{ id: 1, from: Date.parse(T("19:00")), to: Date.parse(T("22:00")) }];
    assert.equal(windowsContaining(T("19:00"), w).length, 1);
    assert.equal(windowsContaining(T("22:00"), w).length, 1);
    assert.equal(windowsContaining("2026-03-02T22:00:00.001Z", w).length, 0);
    assert.equal(windowsContaining("2026-03-02T18:59:59.999Z", w).length, 0);
    assert.equal(windowsContaining(null, w).length, 0);
  });

  it("recordedAfterLink: strictly after, compared to the microsecond; unknown on either side is NOT late (the pre-H180 behaviour)", () => {
    const link = { recorded_at: "2026-10-05T00:00:01.000500+00:00" };
    assert.equal(recordedAfterLink({ recorded_at: "2026-10-05T00:00:01.000501+00:00" }, link), true, "one microsecond later, the same millisecond");
    assert.equal(recordedAfterLink({ recorded_at: "2026-10-05T00:00:01.0005+00:00" }, link), false, "equal is not after");
    assert.equal(recordedAfterLink({ recorded_at: "2026-10-05T00:00:00+00:00" }, link), false);
    assert.equal(recordedAfterLink({ recorded_at: "2026-10-05T00:00:02+00:00" }, null), false);
    assert.equal(recordedAfterLink({ recorded_at: null }, link), false);
    assert.equal(recordedAfterLink({ recorded_at: "garbage" }, link), false);
  });
});
