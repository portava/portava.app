/**
 * §7 candidate inbox — /me/memory-candidates over the real router and a
 * table-backed fake that models migration 2320's constraints: the replay key,
 * the evidence dedupe key, and memory_episodes_eligibility_check.
 * Census H18 / H19 / H23 / H24 / H179 / H238 / H218.
 *
 * WHAT THESE TESTS HOLD (assertions are on the STORE)
 *   - Detection is the owner's, over THEIR trip's captured media: a capture
 *     with no capture time, a flagged one, another person's, one already in a
 *     Memory and one outside the trip are not evidence.
 *   - Detection is deterministic and replayable: a re-run writes nothing new.
 *   - Late evidence never overwrites a decision (H179): a new capture in a
 *     window joins the existing episode as evidence and the episode row is not
 *     touched; a window the owner REJECTED is never proposed again.
 *   - Raw signal does not become Memory: a candidate carries no significance;
 *     confirming scores it, records `user_affirmed`, and creates ONE private
 *     Memory through the §17 boundary with the captures attached — a retry
 *     after any failure creates no second Memory.
 *   - A rejected candidate leaves no Memory behind, so it cannot become a
 *     Highlight (H238); a half-confirmed candidate cannot be rejected.
 *   - Absent storage is feature_disabled; unreadable is 503 and writes nothing.
 *
 * Run: node --import tsx/esm --test src/test/memoryCandidates.test.ts
 */
import { describe, it, afterEach, beforeEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import memoryCandidatesRouter from "../routes/memoryCandidates.js";
import { resetHighlightSchemaMemo } from "../services/highlights/highlightSchemaAvailability.js";
import { _resetMemoryKernelMetrics, readMemoryKernelMetrics } from "../services/memory/memoryKernelMetrics.js";

const OWNER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const TRIP = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const OTHER_TRIP = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const NODATE_TRIP = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";

const m = (n: number) => `30000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const m_ = m;
const url = (n: number) => `https://cdn.example.test/u/${OWNER}/p${n}.jpg`;

function media(n: number, captured: string | null, over: Record<string, unknown> = {}) {
  return {
    id: m(n), owner_user_id: OWNER, media_type: "image", mime_type: "image/jpeg", public_url: url(n),
    captured_at: captured, source_type: "user", moderation_status: "approved", processing_status: "ready",
    deleted_at: null, provenance: null, created_at: "2026-03-02T22:00:00.000Z", ...over,
  };
}

function seed(): Record<string, any[]> {
  return {
    feature_flags: [],
    trips: [
      { id: TRIP, owner_id: OWNER, start_date: "2026-03-01", end_date: "2026-03-05", destination_city: "Lisbon", destination_country: "Portugal" },
      { id: OTHER_TRIP, owner_id: OTHER, start_date: "2026-03-01", end_date: "2026-03-05", destination_city: "Porto", destination_country: "Portugal" },
      { id: NODATE_TRIP, owner_id: OWNER, start_date: null, end_date: null, destination_city: "Faro", destination_country: "Portugal" },
    ],
    trip_members: [],
    media_assets: [
      // Cluster A — an evening.
      media(1, "2026-03-02T19:00:00.000Z"), media(2, "2026-03-02T19:40:00.000Z"), media(3, "2026-03-02T20:30:00.000Z"),
      // Cluster B — next afternoon, well past the 3h gap.
      media(4, "2026-03-03T14:00:00.000Z"), media(5, "2026-03-03T15:10:00.000Z"),
      // Not evidence, each for its own reason:
      media(6, null),                                                         // no capture time (upload time is not capture time)
      media(7, "2026-03-02T19:10:00.000Z", { moderation_status: "flagged" }), // a moderator's verdict
      media(8, "2026-03-02T19:20:00.000Z", { owner_user_id: OTHER }),         // someone else's
      media(9, "2026-03-02T19:30:00.000Z"),                                   // already in a Memory
      media(10, "2026-04-20T10:00:00.000Z"),                                  // outside the trip
      media(11, "2026-03-02T19:50:00.000Z", { processing_status: "failed" }), // never became a file
      media(13, "2026-03-02T19:15:00.000Z", { source_type: "generated" }),    // not the owner's capture
      media(14, "2026-03-02T19:05:00.000Z", { processing_status: "removed", moderation_status: "owner_deleted", deleted_at: "2026-03-02T23:00:00.000Z" }), // deleted before detection
    ],
    memories: [{ id: "90000000-0000-4000-8000-000000000001", owner_id: OWNER, state: "published" }],
    memory_items: [{ id: "91000000-0000-4000-8000-000000000001", memory_id: "90000000-0000-4000-8000-000000000001", media_url: url(9), media_type: "image/jpeg", position: 0 }],
    memory_episodes: [],
    memory_evidence: [],
  };
}

let gen = 0;
const newId = () => `e${String(++gen).padStart(7, "0")}-0000-4000-8000-000000000000`;

interface FakeOpts { absent?: Set<string>; failReads?: Set<string>; failWrites?: Set<string>; beforeUpdate?: (table: string, store: Record<string, any[]>) => void }

function makeClient(store: Record<string, any[]>, opts: FakeOpts) {
  function chain(table: string) {
    const filters: Array<(r: any) => boolean> = [];
    let single = false, wantRows = false;
    let mode: "select" | "insert" | "upsert" | "update" = "select";
    let payload: any = null;
    let upsertOpts: { onConflict?: string; ignoreDuplicates?: boolean } = {};
    let limitN: number | null = null;
    let orderBy: { col: string; asc: boolean } | null = null;
    const obj: any = {
      select() { if (mode !== "select") wantRows = true; return obj; },
      insert(d: any) { mode = "insert"; payload = d; return obj; },
      upsert(d: any, o: any) { mode = "upsert"; payload = d; upsertOpts = o ?? {}; return obj; },
      update(d: any) { mode = "update"; payload = d; return obj; },
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
      // A real round trip yields the event loop. Without this every handler ran
      // to completion before a concurrent request's handler started, and a race
      // could never be observed — PROBE 1 and PROBE 3 passed against the code
      // that had the race.
      await new Promise((r) => setTimeout(r, 1));
      if (opts.absent?.has(table)) return err(`relation "public.${table}" does not exist`, "42P01");
      if (mode === "select" && opts.failReads?.has(table)) return err(`${table} unavailable`, "57014");
      if (mode !== "select" && opts.failWrites?.has(`${table}:${mode}`)) return err(`${table} ${mode} failed`, "57014");
      const all = (store[table] ??= []);
      if (mode === "insert" || mode === "upsert") {
        const incoming = (Array.isArray(payload) ? payload : [payload]).map((r: any) => ({ ...r }));
        const written: any[] = [];
        for (const r of incoming) {
          if (table === "memory_episodes") {
            const dup = all.find((x) => x.user_id === r.user_id && x.detection_reason === r.detection_reason
              && x.detector_version === r.detector_version && x.detection_digest === r.detection_digest && r.detection_digest != null);
            if (dup) return err("duplicate key value violates unique constraint \"memory_episodes_replay_key\"", "23505");
            if (!["candidate", "rejected", "deleted"].includes(r.state ?? "candidate") && (r.significance == null || r.significance_basis == null)) {
              return err("new row violates check constraint \"memory_episodes_eligibility_check\"", "23514");
            }
            Object.assign(r, { id: newId(), state: r.state ?? "candidate", significance: r.significance ?? null, significance_basis: r.significance_basis ?? null,
              state_changed_at: "2026-10-05T00:00:00.000Z", merged_into_id: null, sensitivity: "normal",
              retention_class: "trip_context", created_at: `2026-10-05T00:00:${String(gen).padStart(2, "0")}.000Z`, updated_at: "2026-10-05T00:00:00.000Z" });
          } else if (table === "memory_evidence") {
            const dup = all.find((x) => x.episode_id === r.episode_id && x.source_table === r.source_table
              && x.source_id === r.source_id && x.truth_level === r.truth_level);
            if (dup) {
              if (mode === "upsert" && upsertOpts.ignoreDuplicates) continue;
              return err("duplicate key value violates unique constraint \"memory_evidence_dedupe_idx\"", "23505");
            }
            Object.assign(r, { id: newId(), recorded_at: "2026-10-05T00:00:00.000Z" });
          } else {
            // A primary key: an explicit id already present is refused, as the database would.
            if (r.id != null && all.some((x) => x.id === r.id)) {
              return err(`duplicate key value violates unique constraint "${table}_pkey"`, "23505");
            }
            r.id = r.id ?? newId();
          }
          all.push(r);
          written.push(r);
        }
        if (!wantRows) return { data: null, error: null };
        return { data: single ? written[0] ?? null : written, error: null };
      }
      if (mode === "update" && opts.beforeUpdate) opts.beforeUpdate(table, store);
      let matched = all.filter((r) => filters.every((f) => f(r)));
      if (mode === "update") {
        for (const r of matched) {
          const next = { ...r, ...payload };
          // 2320's memory_episodes_eligibility_check, enforced as the database would.
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
        matched = [...matched].sort((a, b) => (String(a[col] ?? "") < String(b[col] ?? "") ? -1 : String(a[col] ?? "") > String(b[col] ?? "") ? 1 : 0) * (asc ? 1 : -1));
      }
      if (limitN != null) matched = matched.slice(0, limitN);
      if (single) return { data: matched[0] ? { ...matched[0] } : null, error: null };
      return { data: matched.map((r) => ({ ...r })), error: null };
    }
    return obj;
  }
  return {
    from: (t: string) => chain(t),
    rpc: async () => ({ data: null, error: { message: "rpc not modelled" } }),
    auth: { getUser: async (token: string) => ({ data: { user: { id: token } }, error: null }) },
  };
}

interface App { base: string; store: Record<string, any[]>; close: () => Promise<void> }

async function start(opts: FakeOpts & { mutate?: (s: Record<string, any[]>) => void } = {}): Promise<App> {
  resetHighlightSchemaMemo();
  const store = seed();
  opts.mutate?.(store);
  _setTestClient(makeClient(store, opts) as any, true);
  const app = express();
  app.use(express.json());
  app.use((req: any, _r: any, n: any) => { req.log = { error: () => {}, info: () => {}, warn: () => {} }; n(); });
  app.use("/api", memoryCandidatesRouter);
  const srv = http.createServer(app);
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
  const { port } = srv.address() as { port: number };
  return { base: `http://127.0.0.1:${port}`, store, close: () => new Promise<void>((r) => { srv.closeAllConnections(); srv.close(() => r()); }) };
}

async function call(app: App, method: string, path: string, actor: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(app.base + path, {
    method,
    headers: { Authorization: `Bearer ${actor}`, "Content-Type": "application/json", connection: "close", ...headers },
    body: body === undefined ? (method === "POST" ? "{}" : undefined) : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: any = null; try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
  return { status: res.status, body: parsed };
}

const detect = (app: App, actor = OWNER, tripId = TRIP) => call(app, "POST", "/api/me/memory-candidates/detect", actor, { tripId });

let app: App | null = null;
beforeEach(() => { _resetMemoryKernelMetrics(); });
afterEach(async () => { if (app) { await app.close(); app = null; } });

describe("POST /me/memory-candidates/detect — the owner's trip media, grouped, gated, stored as candidates", () => {
  it("stores one PRIVATE candidate per cluster, with only the owner's timed, unflagged, unused captures as evidence", async () => {
    app = await start();
    const r = await detect(app);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const eps = app.store.memory_episodes;
    assert.equal(eps.length, 2, "two clusters → two candidates");
    for (const e of eps) {
      assert.equal(e.user_id, OWNER);
      assert.equal(e.state, "candidate");
      assert.equal(e.visibility, "private");
      assert.equal(e.detection_reason, "media_cluster");
      assert.equal(e.detector_version, 1);
      assert.equal(typeof e.detection_digest, "string");
      assert.equal(e.significance, null, "raw signal carries no significance — it is not Memory");
      assert.equal(e.city, "Lisbon");
    }
    const ids = (ep: any) => app!.store.memory_evidence.filter((v) => v.episode_id === ep.id).map((v) => v.source_id).sort();
    const [a, b] = [...eps].sort((x, y) => String(x.started_at).localeCompare(String(y.started_at)));
    assert.deepEqual(ids(a), [m(1), m(2), m(3)]);
    assert.deepEqual(ids(b), [m(4), m(5)]);
    for (const v of app.store.memory_evidence) {
      assert.deepEqual([v.truth_level, v.source_class, v.source_table, v.user_id], ["observed", "system", "media_assets", OWNER]);
    }
    assert.equal(r.body.report.capturesWithoutTime, 1);
    assert.equal(r.body.report.capturesAlreadyInMemories, 1);
    assert.equal(a.started_at, "2026-03-02T19:00:00.000Z");
    assert.equal(a.ended_at, "2026-03-02T20:30:00.000Z");
  });

  it("a replay writes nothing new", async () => {
    app = await start();
    await detect(app);
    const before = JSON.stringify(app.store);
    const r = await detect(app);
    assert.equal(r.status, 200);
    assert.equal(JSON.stringify(app.store), before, "the same inputs, the same rows — nothing appended");
    assert.ok(r.body.report.candidates.every((c: any) => c.created === false && c.evidenceAdded === 0));
  });

  it("LATE EVIDENCE: a new capture joins the existing episode as evidence, and the episode row is not touched (H179)", async () => {
    app = await start();
    await detect(app);
    const epA = app.store.memory_episodes.find((e) => e.started_at === "2026-03-02T19:00:00.000Z");
    const snapshot = { ...epA };
    // Later than the episode's end: the detector now groups 19:00–21:15, so a
    // writer that "refreshed" the row would move ended_at. It must not.
    app.store.media_assets.push(media(12, "2026-03-02T21:15:00.000Z"));
    const r = await detect(app);
    assert.equal(r.status, 200);
    assert.equal(app.store.memory_episodes.length, 2, "no second episode for the same evening");
    assert.deepEqual({ ...app.store.memory_episodes.find((e) => e.id === epA.id) }, snapshot, "the episode row is unchanged");
    assert.ok(app.store.memory_evidence.some((v) => v.episode_id === epA.id && v.source_id === m(12)), "the new capture is evidence on it");
  });

  it("a window the owner REJECTED is never proposed again", async () => {
    app = await start();
    await detect(app);
    const epA = app.store.memory_episodes.find((e) => e.started_at === "2026-03-02T19:00:00.000Z");
    assert.equal((await call(app, "POST", `/api/me/memory-candidates/${epA.id}/reject`, OWNER)).status, 200);
    app.store.media_assets.push(media(12, "2026-03-02T20:00:00.000Z"));
    const evidenceBefore = app.store.memory_evidence.length;
    const r = await detect(app);
    assert.equal(app.store.memory_episodes.length, 2);
    assert.equal(app.store.memory_episodes.find((e) => e.id === epA.id).state, "rejected");
    assert.equal(app.store.memory_evidence.length, evidenceBefore, "nothing is appended to a rejected window");
    assert.ok(r.body.report.candidates.some((c: any) => c.episodeId === epA.id && c.suppressedBy === "rejected"));
  });

  it("refuses a trip the caller is not on (404), one with no dates (409), and writes nothing", async () => {
    app = await start();
    assert.equal((await detect(app, OWNER, OTHER_TRIP)).status, 404);
    const nodate = await detect(app, OWNER, NODATE_TRIP);
    assert.equal(nodate.status, 409);
    assert.equal(nodate.body.reason, "trip_has_no_dates");
    assert.equal(app.store.memory_episodes.length + app.store.memory_evidence.length, 0);
  });

  it("an accepted crew member may look through their OWN media on the trip; an invited one may not", async () => {
    app = await start({ mutate: (s) => { s.trip_members.push({ trip_id: OTHER_TRIP, user_id: OWNER, role: "member", status: "accepted" }); } });
    assert.equal((await detect(app, OWNER, OTHER_TRIP)).status, 200);
    await app.close();
    // A legacy row with no status: only the ROLE says this person never accepted.
    app = await start({ mutate: (s) => { s.trip_members.push({ trip_id: OTHER_TRIP, user_id: OWNER, role: "invited", status: null }); } });
    assert.equal((await detect(app, OWNER, OTHER_TRIP)).status, 404);
  });

  for (const table of ["trips", "trip_members", "media_assets", "memories", "memory_items"]) {
    it(`an unreadable ${table} is 503 and writes nothing — never an empty inbox`, async () => {
      app = await start({ failReads: new Set([table]) });
      const r = await detect(app);
      assert.equal(r.status, 503, JSON.stringify(r.body));
      assert.equal(app.store.memory_episodes.length + app.store.memory_evidence.length, 0);
    });
  }

  it("2320 not deployed is feature_disabled on every route, and nothing is read or written", async () => {
    app = await start({ absent: new Set(["memory_episodes"]) });
    assert.equal((await detect(app)).status, 404);
    const list = await call(app, "GET", "/api/me/memory-candidates", OWNER);
    assert.deepEqual([list.status, list.body.error], [404, "feature_disabled"]);
  });

  it("an unreadable spine is 503, not feature_disabled", async () => {
    app = await start({ failReads: new Set(["memory_evidence"]) });
    const list = await call(app, "GET", "/api/me/memory-candidates", OWNER);
    assert.equal(list.status, 503);
  });
});

describe("GET /me/memory-candidates — the owner's inbox", () => {
  it("lists the owner's open candidates with their own previews; another person sees none of them", async () => {
    app = await start();
    await detect(app);
    const r = await call(app, "GET", "/api/me/memory-candidates", OWNER);
    assert.equal(r.status, 200);
    assert.equal(r.body.candidates.length, 2);
    const a = r.body.candidates.find((c: any) => c.startedAt === "2026-03-02T19:00:00.000Z");
    assert.equal(a.captureCount, 3);
    assert.deepEqual(a.previewUrls.sort(), [url(1), url(2), url(3)].sort());
    const other = await call(app, "GET", "/api/me/memory-candidates", OTHER);
    assert.deepEqual(other.body.candidates, []);
  });
});

describe("confirm and reject — the owner's decision", () => {
  async function seeded() {
    const a = await start();
    await detect(a);
    const epA = a.store.memory_episodes.find((e) => e.started_at === "2026-03-02T19:00:00.000Z");
    return { a, epA };
  }

  it("confirm scores it, records user_affirmed, and creates ONE private Memory with the captures in capture order", async () => {
    const { a, epA } = await seeded(); app = a;
    const r = await call(app, "POST", `/api/me/memory-candidates/${epA.id}/confirm`, OWNER, { title: "Fado night" }, { "Idempotency-Key": "k-confirm-1" });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const ep = app.store.memory_episodes.find((e) => e.id === epA.id);
    assert.equal(ep.state, "confirmed");
    assert.equal(typeof ep.significance, "number");
    assert.equal(ep.significance_basis, "user_affirmed");
    assert.equal(ep.summary, "Fado night");
    const created = app.store.memories.filter((x) => x.id === r.body.memoryId);
    assert.equal(created.length, 1);
    assert.deepEqual([created[0].owner_id, created[0].visibility, created[0].state, created[0].title], [OWNER, "only_me", "published", "Fado night"]);
    assert.equal(created[0].starts_at, "2026-03-02T19:00:00.000Z");
    const items = app.store.memory_items.filter((i) => i.memory_id === r.body.memoryId).sort((x, y) => x.position - y.position);
    assert.deepEqual(items.map((i) => i.media_url), [url(1), url(2), url(3)]);
    const link = app.store.memory_evidence.filter((v) => v.episode_id === epA.id && v.source_table === "memories");
    assert.deepEqual(link.map((v) => [v.source_id, v.truth_level, v.source_class]), [[r.body.memoryId, "asserted", "explicit"]]);
    const counts = readMemoryKernelMetrics().counts;
    assert.equal(counts.explicitMemoriesCreated, 1);
    assert.equal(counts.explicitMemoriesWithoutCandidate, 0, "a confirmed candidate is NOT an explicit Memory without a candidate (H218)");
    assert.equal(counts.candidatesOwnerConfirmed, 1);
  });

  it("a confirm retried after it succeeded creates no second Memory and no duplicate photos", async () => {
    const { a, epA } = await seeded(); app = a;
    const first = await call(app, "POST", `/api/me/memory-candidates/${epA.id}/confirm`, OWNER, {});
    const second = await call(app, "POST", `/api/me/memory-candidates/${epA.id}/confirm`, OWNER, {});
    assert.equal(second.status, 200);
    assert.equal(second.body.memoryId, first.body.memoryId);
    assert.equal(second.body.replayed, true);
    assert.equal(app.store.memories.filter((x) => x.owner_id === OWNER).length, 2, "the seeded Memory plus exactly one");
    assert.equal(app.store.memory_items.filter((i) => i.memory_id === first.body.memoryId).length, 3);
  });

  it("PROBE 1 — two Keeps at once make ONE Memory, three photos and one link, and both callers are told so", async () => {
    const { a, epA } = await seeded(); app = a;
    const [r1, r2] = await Promise.all([
      call(app, "POST", `/api/me/memory-candidates/${epA.id}/confirm`, OWNER, {}, { "Idempotency-Key": "tap-1" }),
      call(app, "POST", `/api/me/memory-candidates/${epA.id}/confirm`, OWNER, {}, { "Idempotency-Key": "tap-2" }),
    ]);
    assert.deepEqual([r1.status, r2.status], [200, 200], JSON.stringify([r1.body, r2.body]));
    assert.equal(r1.body.memoryId, r2.body.memoryId);
    const mine = app.store.memories.filter((x) => x.owner_id === OWNER && x.id !== "90000000-0000-4000-8000-000000000001");
    assert.equal(mine.length, 1, "one Memory, not one per tap");
    assert.equal(app.store.memory_items.filter((i) => i.memory_id === r1.body.memoryId).length, 3, "three photos, not six");
    assert.equal(app.store.memory_evidence.filter((v) => v.episode_id === epA.id && v.source_table === "memories").length, 1, "one link");
  });

  it("PROBE 2 — a link write that fails after the Memory exists is finished by the retry with the same key: still ONE Memory", async () => {
    app = await start({ failWrites: new Set(["memory_evidence:upsert"]) });
    // Detection itself writes evidence through upsert, so seed it on a healthy client first.
    const healthy = makeClient(app.store, {});
    _setTestClient(healthy as any, true);
    await detect(app);
    const epA = app.store.memory_episodes.find((e) => e.started_at === "2026-03-02T19:00:00.000Z");
    _setTestClient(makeClient(app.store, { failWrites: new Set(["memory_evidence:upsert"]) }) as any, true);
    const failed = await call(app, "POST", `/api/me/memory-candidates/${epA.id}/confirm`, OWNER, {}, { "Idempotency-Key": "k-1" });
    assert.equal(failed.status, 503);
    assert.equal(app.store.memory_episodes.find((e) => e.id === epA.id).state, "confirmed", "the claim held");
    assert.equal(app.store.memories.filter((x) => x.owner_id === OWNER).length, 2, "the seeded Memory plus the one this Keep made");
    // The interrupted Keep is still in front of the owner.
    _setTestClient(healthy as any, true);
    const list = await call(app, "GET", "/api/me/memory-candidates", OWNER);
    assert.equal(list.body.candidates.find((c: any) => c.id === epA.id)?.state, "interrupted");
    const retry = await call(app, "POST", `/api/me/memory-candidates/${epA.id}/confirm`, OWNER, {}, { "Idempotency-Key": "k-1" });
    assert.equal(retry.status, 200, JSON.stringify(retry.body));
    assert.equal(app.store.memories.filter((x) => x.owner_id === OWNER).length, 2, "the retry made no second Memory");
    assert.equal(app.store.memory_evidence.filter((v) => v.episode_id === epA.id && v.source_table === "memories").length, 1);
    assert.equal(app.store.memory_items.filter((i) => i.memory_id === retry.body.memoryId).length, 3);
    const after = await call(app, "GET", "/api/me/memory-candidates", OWNER);
    assert.ok(!after.body.candidates.some((c: any) => c.id === epA.id), "a finished Keep leaves the inbox");
  });

  it("PROBE 3 — Keep and Dismiss at once never leave a rejected candidate with a Memory (H238)", async () => {
    for (const order of ["confirm-first", "reject-first"] as const) {
      const { a, epA } = await seeded(); app = a;
      const keep = () => call(app!, "POST", `/api/me/memory-candidates/${epA.id}/confirm`, OWNER, {});
      const dismiss = () => call(app!, "POST", `/api/me/memory-candidates/${epA.id}/reject`, OWNER);
      const [k, d] = order === "confirm-first"
        ? await Promise.all([keep(), dismiss()])
        : await Promise.all([dismiss(), keep()]).then(([dd, kk]) => [kk, dd]);
      const state = app.store.memory_episodes.find((e) => e.id === epA.id).state;
      const made = app.store.memories.filter((m) => m.owner_id === OWNER && m.id !== "90000000-0000-4000-8000-000000000001").length;
      assert.ok((state === "confirmed" && made === 1) || (state === "rejected" && made === 0),
        `${order}: state ${state} with ${made} Memory — ${JSON.stringify([k.status, d.status])}`);
      // Exactly one decision wins, and each caller is told the truth about it.
      assert.ok((k.status === 200) !== (d.status === 200), `${order}: keep ${k.status}, dismiss ${d.status} — exactly one may succeed`);
      assert.equal(state, k.status === 200 ? "confirmed" : "rejected");
      await app.close(); app = null;
    }
  });

  it("a Dismiss that commits between Keep's read and Keep's claim wins: the claim changes nothing and no Memory is made (H238)", async () => {
    let raced = false;
    app = await start({
      beforeUpdate: (table, st) => {
        if (table !== "memory_episodes" || raced) return;
        raced = true;
        // The concurrent Dismiss commits first.
        const ep = st.memory_episodes.find((e) => e.started_at === "2026-03-02T19:00:00.000Z");
        if (ep) ep.state = "rejected";
      },
    });
    await detect(app);
    const epA = app.store.memory_episodes.find((e) => e.started_at === "2026-03-02T19:00:00.000Z");
    const r = await call(app, "POST", `/api/me/memory-candidates/${epA.id}/confirm`, OWNER, {});
    assert.equal(r.status, 409, JSON.stringify(r.body));
    assert.equal(app.store.memory_episodes.find((e) => e.id === epA.id).state, "rejected");
    assert.equal(app.store.memories.filter((x) => x.owner_id === OWNER).length, 1, "only the seeded Memory");
  });

  it("a Keep whose claim cannot be written makes no Memory at all", async () => {
    app = await start({ failWrites: new Set(["memory_episodes:update"]) });
    await detect(app);
    const epA = app.store.memory_episodes.find((e) => e.started_at === "2026-03-02T19:00:00.000Z");
    const r = await call(app, "POST", `/api/me/memory-candidates/${epA.id}/confirm`, OWNER, {});
    assert.equal(r.status, 503);
    assert.equal(app.store.memories.filter((x) => x.owner_id === OWNER).length, 1, "only the seeded Memory");
    assert.equal(app.store.memory_episodes.find((e) => e.id === epA.id).state, "candidate");
  });

  it("a kept (claimed) suggestion cannot be dismissed — its Memory would outlive the rejection (H238)", async () => {
    const { a, epA } = await seeded(); app = a;
    epA.state = "confirmed"; epA.significance = 0.5; epA.significance_basis = "user_affirmed";
    const r = await call(app, "POST", `/api/me/memory-candidates/${epA.id}/reject`, OWNER);
    assert.equal(r.status, 409);
    assert.equal(app.store.memory_episodes.find((e) => e.id === epA.id).state, "confirmed");
  });

  it("deleted and late-flagged photos are neither previewed nor attached", async () => {
    app = await start({ mutate: (st) => { st.media_assets.push(media(15, "2026-03-02T19:45:00.000Z")); } });
    await detect(app);
    const epA = app.store.memory_episodes.find((e) => e.started_at === "2026-03-02T19:00:00.000Z");
    // After detection: the owner deletes one capture, a moderator flags another,
    // and a third has its deletion recorded while processing still reads 'ready'.
    Object.assign(app.store.media_assets.find((m) => m.id === m_(1)), { processing_status: "removed", moderation_status: "owner_deleted", deleted_at: "2026-10-05T00:00:00.000Z" });
    Object.assign(app.store.media_assets.find((m) => m.id === m_(2)), { moderation_status: "flagged" });
    Object.assign(app.store.media_assets.find((m) => m.id === m_(15)), { deleted_at: "2026-10-05T00:00:00.000Z" });
    const list = await call(app, "GET", "/api/me/memory-candidates", OWNER);
    assert.deepEqual(list.body.candidates.find((c: any) => c.id === epA.id).previewUrls, [url(3)]);
    const kept = await call(app, "POST", `/api/me/memory-candidates/${epA.id}/confirm`, OWNER, {});
    assert.equal(kept.status, 200);
    assert.deepEqual(app.store.memory_items.filter((i) => i.memory_id === kept.body.memoryId).map((i) => i.media_url), [url(3)]);
  });

  it("reject moves candidate → rejected and creates nothing a Highlight could be made from (H238)", async () => {
    const { a, epA } = await seeded(); app = a;
    const memoriesBefore = app.store.memories.length;
    const r = await call(app, "POST", `/api/me/memory-candidates/${epA.id}/reject`, OWNER);
    assert.equal(r.status, 200);
    assert.equal(app.store.memory_episodes.find((e) => e.id === epA.id).state, "rejected");
    assert.equal(app.store.memories.length, memoriesBefore, "no Memory exists for a rejected candidate");
    assert.equal(readMemoryKernelMetrics().counts.candidatesOwnerRejected, 1);
    const again = await call(app, "POST", `/api/me/memory-candidates/${epA.id}/reject`, OWNER);
    assert.deepEqual([again.status, again.body.replayed], [200, true]);
    const confirm = await call(app, "POST", `/api/me/memory-candidates/${epA.id}/confirm`, OWNER, {});
    assert.equal(confirm.status, 409, "a rejected candidate cannot be confirmed into a Memory");
  });

  it("another person's candidate is a 404 to confirm or reject, and is left untouched", async () => {
    const { a, epA } = await seeded(); app = a;
    const before = JSON.stringify(app.store);
    assert.equal((await call(app, "POST", `/api/me/memory-candidates/${epA.id}/confirm`, OTHER, {})).status, 404);
    assert.equal((await call(app, "POST", `/api/me/memory-candidates/${epA.id}/reject`, OTHER)).status, 404);
    assert.equal(JSON.stringify(app.store), before);
  });
});
