/**
 * §21 RAW_EVIDENCE_PURGED on the provenance spine 2320 REALLY creates.
 * Census H52 (deletion lifecycle) and H190 ("purge canonical/eligible evidence").
 *
 * THE DEFECT. The deletion lifecycle's step 4 deleted
 * `memory_evidence WHERE memory_id = <id>`. 2320's memory_evidence has no
 * `memory_id` column (evidence hangs off an episode; a kept candidate names its
 * Memory with one explicit link row), so wherever 2320 is applied the purge was
 * a 42703: retried, dead-lettered on every deletion, and the captures plus the
 * link survived the deletion. The suite next door could not see it — its fake
 * answers an unknown column with zero rows, which reads as "nothing to purge".
 *
 * THE FAKE HERE KNOWS 2320's COLUMNS. A filter, an order or a written key on a
 * column the migration does not create is answered the way PostgREST answers
 * it (42703 for a filter, PGRST204 for a payload key), so a query against the
 * wrong shape fails in this suite as it would against the database.
 *
 * Every assertion is on the STORE after the real routers ran:
 *   POST /api/me/memory-candidates/detect | /:id/confirm  (episodeCandidates)
 *   DELETE /api/memories/:id                              (the §21 lifecycle)
 *
 * Run: node --import tsx/esm --test src/test/memoryDeletionEvidencePurge.test.ts
 */
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import memoryCandidatesRouter from "../routes/memoryCandidates.js";
import memoriesRouter from "../routes/memories.js";
import { resetHighlightSchemaMemo } from "../services/highlights/highlightSchemaAvailability.js";
import { runMemoryDeletionLifecycle } from "../services/memory/memoryDeletionLifecycle.js";
import { runMemoryDeletionRedrivePass } from "../lib/memoryDeletionRedriveScheduler.js";

const OWNER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const TRIP = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const PLAIN_MEMORY = "90000000-0000-4000-8000-000000000001";
const FOREIGN_EPISODE = "e9999999-0000-4000-8000-000000000000";

/** 2320's columns, verbatim from the CREATE TABLE statements. */
const COLUMNS_2320: Record<string, ReadonlySet<string>> = {
  memory_episodes: new Set([
    "id", "user_id", "episode_kind", "summary", "started_at", "ended_at", "place_id", "city", "country",
    "detection_reason", "detector_version", "detection_digest", "significance", "significance_basis",
    "state", "state_changed_at", "merged_into_id", "sensitivity", "visibility", "retention_class",
    "created_at", "updated_at",
  ]),
  memory_evidence: new Set([
    "id", "episode_id", "user_id", "truth_level", "source_class", "source_table", "source_id",
    "source_ref", "observed_at", "recorded_at", "weight",
  ]),
  // 3670, verbatim from its CREATE TABLE.
  memory_deletion_dead_letters: new Set([
    "memory_id", "owner_id", "failed_steps", "reached_state", "detail", "lifecycle_version",
    "letters", "first_failed_at", "last_failed_at", "resolved_at",
  ]),
};

const m = (n: number) => `30000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const url = (n: number) => `https://cdn.example.test/u/${OWNER}/p${n}.jpg`;
function media(n: number, captured: string) {
  return {
    id: m(n), owner_user_id: OWNER, media_type: "image", mime_type: "image/jpeg", public_url: url(n),
    captured_at: captured, source_type: "user", moderation_status: "approved", processing_status: "ready",
    deleted_at: null, provenance: null, created_at: "2026-03-02T22:00:00.000Z",
  };
}

function seed(): Record<string, any[]> {
  return {
    feature_flags: [],
    trips: [{ id: TRIP, owner_id: OWNER, start_date: "2026-03-01", end_date: "2026-03-05", destination_city: "Lisbon", destination_country: "Portugal" }],
    trip_members: [],
    media_assets: [
      media(1, "2026-03-02T19:00:00.000Z"), media(2, "2026-03-02T19:40:00.000Z"), media(3, "2026-03-02T20:30:00.000Z"),
      media(4, "2026-03-03T14:00:00.000Z"), media(5, "2026-03-03T15:10:00.000Z"),
    ],
    memories: [{
      id: PLAIN_MEMORY, owner_id: OWNER, title: "plain", caption: null, visibility: "only_me",
      allowed_user_ids: [], hidden_user_ids: [], trip_id: null, event_id: null, place_id: null,
      state: "published", created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z",
    }],
    memory_items: [],
    memory_episodes: [{
      id: FOREIGN_EPISODE, user_id: OTHER, episode_kind: "activity", summary: "theirs", started_at: "2026-03-02T19:00:00.000Z",
      ended_at: "2026-03-02T20:00:00.000Z", place_id: null, city: "Lisbon", country: "Portugal", detection_reason: "media_cluster",
      detector_version: 1, detection_digest: "x", significance: 0.6, significance_basis: "user_affirmed", state: "confirmed",
      state_changed_at: "2026-03-03T00:00:00.000Z", merged_into_id: null, sensitivity: "normal", visibility: "private",
      retention_class: "trip_context", created_at: "2026-03-03T00:00:00.000Z", updated_at: "2026-03-03T00:00:00.000Z",
    }],
    memory_evidence: [],
  };
}

let gen = 0;
const newId = () => `e${String(++gen).padStart(7, "0")}-0000-4000-8000-000000000000`;

interface FakeOpts { absent?: Set<string>; failWrites?: Set<string> }

function makeClient(store: Record<string, any[]>, opts: FakeOpts = {}) {
  function chain(table: string) {
    const filters: Array<(r: any) => boolean> = [];
    const named: string[] = [];
    let single = false, wantRows = false;
    let mode: "select" | "insert" | "upsert" | "update" | "delete" = "select";
    let payload: any = null;
    let upsertOpts: { onConflict?: string; ignoreDuplicates?: boolean } = {};
    let limitN: number | null = null;
    let orderBy: { col: string; asc: boolean } | null = null;
    const f = (c: string, p: (r: any) => boolean) => { named.push(c); filters.push(p); return obj; };
    const obj: any = {
      select() { if (mode !== "select") wantRows = true; return obj; },
      insert(d: any) { mode = "insert"; payload = d; return obj; },
      upsert(d: any, o: any) { mode = "upsert"; payload = d; upsertOpts = o ?? {}; return obj; },
      update(d: any) { mode = "update"; payload = d; return obj; },
      delete() { mode = "delete"; return obj; },
      eq: (c: string, v: any) => f(c, (r) => r[c] === v),
      neq: (c: string, v: any) => f(c, (r) => r[c] !== v),
      in: (c: string, vs: any[]) => { const s = new Set(vs); return f(c, (r) => s.has(r[c])); },
      is: (c: string, v: any) => f(c, (r) => (v === null ? r[c] == null : r[c] === v)),
      gte: (c: string, v: any) => f(c, (r) => r[c] != null && String(r[c]) >= String(v)),
      lte: (c: string, v: any) => f(c, (r) => r[c] != null && String(r[c]) <= String(v)),
      gt: (c: string, v: any) => f(c, (r) => r[c] != null && String(r[c]) > String(v)),
      lt: (c: string, v: any) => f(c, (r) => r[c] != null && String(r[c]) < String(v)),
      contains: (c: string, vs: any[]) => f(c, (r) => Array.isArray(r[c]) && vs.every((v) => r[c].includes(v))),
      not() { return obj; }, or() { return obj; }, filter() { return obj; },
      order(col: string, o?: any) { named.push(col); orderBy = { col, asc: o?.ascending !== false }; return obj; },
      limit(n: number) { limitN = n; return obj; },
      range() { return obj; },
      maybeSingle() { single = true; return run(); },
      single() { single = true; return run(); },
      then(ok: any, bad: any) { return run().then(ok, bad); },
    };
    const err = (message: string, code: string) => ({ data: null, error: { message, code } });
    async function run(): Promise<any> {
      await new Promise((r) => setTimeout(r, 1));
      if (opts.absent?.has(table)) return err(`relation "public.${table}" does not exist`, "42P01");
      // 2320's SHAPE, enforced: the defect this suite exists for is a query on a column 2320 never created.
      const cols = COLUMNS_2320[table];
      if (cols) {
        const bad = named.find((c) => !cols.has(c));
        if (bad) return err(`column ${table}.${bad} does not exist`, "42703");
        if (payload && (mode === "insert" || mode === "upsert" || mode === "update")) {
          for (const row of Array.isArray(payload) ? payload : [payload]) {
            const k = Object.keys(row).find((key) => !cols.has(key));
            if (k) return err(`Could not find the '${k}' column of '${table}' in the schema cache`, "PGRST204");
          }
        }
      }
      if (mode !== "select" && opts.failWrites?.has(`${table}:${mode}`)) return err(`${table} ${mode} failed`, "57014");
      const all = (store[table] ??= []);
      if (mode === "insert" || mode === "upsert") {
        const written: any[] = [];
        for (const r of (Array.isArray(payload) ? payload : [payload]).map((x: any) => ({ ...x }))) {
          if (table === "memory_episodes") {
            Object.assign(r, { id: newId(), state: r.state ?? "candidate", significance: r.significance ?? null, significance_basis: r.significance_basis ?? null,
              state_changed_at: "2026-10-07T00:00:00.000Z", merged_into_id: null, sensitivity: "normal", retention_class: "trip_context",
              created_at: `2026-10-07T00:00:${String(gen).padStart(2, "0")}.000Z`, updated_at: "2026-10-07T00:00:00.000Z" });
          } else if (table === "memory_evidence") {
            if (all.some((x) => x.episode_id === r.episode_id && x.source_table === r.source_table && x.source_id === r.source_id && x.truth_level === r.truth_level)) {
              if (mode === "upsert" && upsertOpts.ignoreDuplicates) continue;
              return err("duplicate key value violates unique constraint \"memory_evidence_dedupe_idx\"", "23505");
            }
            Object.assign(r, { id: newId(), recorded_at: "2026-10-07T00:00:00.000Z" });
          } else if (table === "memory_deletion_dead_letters") {
            // PRIMARY KEY (memory_id): an upsert on it replaces the row, a plain insert is refused.
            const had = all.find((x) => x.memory_id === r.memory_id);
            if (had) {
              if (mode === "upsert" && upsertOpts.onConflict === "memory_id") { Object.assign(had, r); written.push(had); continue; }
              return err("duplicate key value violates unique constraint \"memory_deletion_dead_letters_pkey\"", "23505");
            }
          } else {
            if (r.id != null && all.some((x) => x.id === r.id)) return err(`duplicate key value violates unique constraint "${table}_pkey"`, "23505");
            r.id = r.id ?? newId();
          }
          all.push(r);
          written.push(r);
        }
        if (!wantRows) return { data: null, error: null };
        return { data: single ? written[0] ?? null : written, error: null };
      }
      let matched = all.filter((r) => filters.every((p) => p(r)));
      if (mode === "delete") {
        store[table] = all.filter((r) => !matched.includes(r));
        return { data: wantRows ? matched.map((r) => ({ ...r })) : null, error: null };
      }
      if (mode === "update") {
        for (const r of matched) {
          const next = { ...r, ...payload };
          if (table === "memory_episodes" && !["candidate", "rejected", "deleted"].includes(next.state)
            && (next.significance == null || next.significance_basis == null)) {
            return err("new row violates check constraint \"memory_episodes_eligibility_check\"", "23514");
          }
          if (table === "memory_episodes" && ((next.state === "merged") !== (next.merged_into_id != null))) {
            return err("new row violates check constraint \"memory_episodes_merge_check\"", "23514");
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
    rpc: async () => ({ data: null, error: { message: "rpc not modelled", code: "PGRST202" } }),
    auth: { getUser: async (token: string) => ({ data: { user: { id: token } }, error: null }) },
  };
}

interface App { base: string; store: Record<string, any[]>; logs: Array<{ obj: any; msg: string }>; close: () => Promise<void> }

async function start(opts: FakeOpts = {}): Promise<App> {
  resetHighlightSchemaMemo();
  const store = seed();
  _setTestClient(makeClient(store, opts) as any, true);
  const logs: Array<{ obj: any; msg: string }> = [];
  const app = express();
  app.use(express.json());
  app.use((req: any, _r: any, n: any) => {
    const push = (obj: any, msg: string) => logs.push({ obj, msg });
    req.log = { error: push, info: push, warn: push };
    n();
  });
  app.use("/api", memoryCandidatesRouter);
  app.use("/api", memoriesRouter);
  const srv = http.createServer(app);
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
  const { port } = srv.address() as { port: number };
  return { base: `http://127.0.0.1:${port}`, store, logs, close: () => new Promise<void>((r) => { srv.closeAllConnections(); srv.close(() => r()); }) };
}

let keyN = 0;
async function call(app: App, method: string, path: string, body?: unknown) {
  const res = await fetch(app.base + path, {
    method,
    headers: { Authorization: `Bearer ${OWNER}`, "Content-Type": "application/json", "Idempotency-Key": `k-${++keyN}`, connection: "close" },
    body: body === undefined ? (method === "POST" ? "{}" : undefined) : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: any = null; try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
  return { status: res.status, body: parsed };
}

const detect = (app: App) => call(app, "POST", "/api/me/memory-candidates/detect", { tripId: TRIP });
const evening = (app: App) => app.store.memory_episodes.find((e) => e.user_id === OWNER && e.started_at === "2026-03-02T19:00:00.000Z");
const afternoon = (app: App) => app.store.memory_episodes.find((e) => e.user_id === OWNER && e.started_at === "2026-03-03T14:00:00.000Z");
const evidenceOf = (app: App, episodeId: string) => app.store.memory_evidence.filter((v) => v.episode_id === episodeId);
const lifecycleReport = (app: App) => app.logs.filter((l) => l.msg === "memories: §21 deletion lifecycle").at(-1)?.obj.report;
const step = (report: any, name: string) => report.steps.find((s: any) => s.step === name);

/** Detect, keep the evening as a Memory titled "Fado night", return its id. */
async function keepEvening(app: App): Promise<{ memoryId: string; episodeId: string }> {
  assert.equal((await detect(app)).status, 200);
  const ep = evening(app);
  const kept = await call(app, "POST", `/api/me/memory-candidates/${ep.id}/confirm`, { title: "Fado night" });
  assert.equal(kept.status, 200, JSON.stringify(kept.body));
  return { memoryId: kept.body.memoryId, episodeId: ep.id };
}

let app: App | null = null;
afterEach(async () => { if (app) { await app.close(); app = null; } });

describe("§21 RAW_EVIDENCE_PURGED — deleting a Memory kept from a candidate", () => {
  it("retires the episode it was kept from and purges every evidence row it rests on — captures AND the link", async () => {
    app = await start();
    const { memoryId, episodeId } = await keepEvening(app);
    assert.equal(evidenceOf(app, episodeId).length, 4, "precondition: three captures and one link");
    const otherCandidate = afternoon(app);
    const otherEvidence = evidenceOf(app, otherCandidate.id).map((v) => v.id).sort();

    const del = await call(app, "DELETE", `/api/memories/${memoryId}`);
    assert.equal(del.status, 204, JSON.stringify(del.body));

    assert.deepEqual(evidenceOf(app, episodeId), [], "no capture and no link outlives the deleted Memory");
    const ep = app.store.memory_episodes.find((e) => e.id === episodeId);
    assert.equal(ep.state, "deleted");
    for (const col of ["summary", "place_id", "city", "country", "significance", "significance_basis"]) {
      assert.equal(ep[col], null, `a retired episode keeps no ${col}`);
    }
    // Nothing that is not this Memory's is touched.
    assert.equal(afternoon(app).state, "candidate");
    assert.deepEqual(evidenceOf(app, otherCandidate.id).map((v) => v.id).sort(), otherEvidence);

    const report = lifecycleReport(app);
    const purge = step(report, "RAW_EVIDENCE_PURGED");
    assert.equal(purge.outcome, "done", JSON.stringify(purge));
    assert.equal(purge.attempts, 1);
    assert.deepEqual([purge.facts.purged, purge.facts.episodesRetired], [4, 1]);
    assert.equal(report.deadLettered, false);
  });

  it("the deleted Memory's photos are never proposed again, and Keep again is refused", async () => {
    app = await start();
    const { memoryId, episodeId } = await keepEvening(app);
    assert.equal((await call(app, "DELETE", `/api/memories/${memoryId}`)).status, 204);
    const episodesBefore = app.store.memory_episodes.length;

    const again = await detect(app);
    assert.equal(again.status, 200);
    assert.equal(app.store.memory_episodes.length, episodesBefore, "no new episode for the deleted Memory's window");
    assert.deepEqual(evidenceOf(app, episodeId), [], "nothing is appended to the retired episode");
    assert.ok(again.body.report.candidates.some((c: any) => c.episodeId === episodeId && c.suppressedBy === "deleted"));

    const inbox = await call(app, "GET", "/api/me/memory-candidates");
    assert.ok(!inbox.body.candidates.some((c: any) => c.id === episodeId), "the inbox does not offer it back");
    const keep = await call(app, "POST", `/api/me/memory-candidates/${episodeId}/confirm`, {});
    assert.equal(keep.status, 409, JSON.stringify(keep.body));
    assert.equal(app.store.memories.find((x) => x.id === memoryId).state, "deleted", "the Memory stays deleted");
  });

  it("another person's evidence naming the same Memory id, and their episode, are untouched", async () => {
    app = await start();
    const { memoryId } = await keepEvening(app);
    app.store.memory_evidence.push({
      id: "f0000000-0000-4000-8000-000000000001", episode_id: FOREIGN_EPISODE, user_id: OTHER, truth_level: "asserted",
      source_class: "explicit", source_table: "memories", source_id: memoryId, source_ref: {}, observed_at: null,
      recorded_at: "2026-03-03T00:00:00.000Z", weight: 1,
    });
    assert.equal((await call(app, "DELETE", `/api/memories/${memoryId}`)).status, 204);
    assert.equal(evidenceOf(app, FOREIGN_EPISODE).length, 1);
    const theirs = app.store.memory_episodes.find((e) => e.id === FOREIGN_EPISODE);
    assert.deepEqual([theirs.state, theirs.summary], ["confirmed", "theirs"]);
  });

  it("a Memory that was never a candidate: the step is `done` with nothing purged, and no episode is touched", async () => {
    app = await start();
    assert.equal((await detect(app)).status, 200);
    const before = JSON.stringify([app.store.memory_episodes, app.store.memory_evidence]);
    assert.equal((await call(app, "DELETE", `/api/memories/${PLAIN_MEMORY}`)).status, 204);
    assert.equal(JSON.stringify([app.store.memory_episodes, app.store.memory_evidence]), before);
    const purge = step(lifecycleReport(app), "RAW_EVIDENCE_PURGED");
    assert.deepEqual([purge.outcome, purge.facts.purged, purge.facts.episodesRetired], ["done", 0, 0]);
  });

  it("2320 not deployed: `not_applicable` with its reason, attempted once — never `done`, never dead-lettered", async () => {
    app = await start({ absent: new Set(["memory_evidence", "memory_episodes"]) });
    assert.equal((await call(app, "DELETE", `/api/memories/${PLAIN_MEMORY}`)).status, 204);
    const report = lifecycleReport(app);
    const purge = step(report, "RAW_EVIDENCE_PURGED");
    assert.equal(purge.outcome, "not_applicable");
    assert.equal(purge.attempts, 1);
    assert.match(purge.detail, /memory_evidence is not deployed/);
    assert.equal(report.deadLettered, false);
  });
});

describe("§21 RAW_EVIDENCE_PURGED — partial failure never reopens a deleted Memory", () => {
  it("purge fails AFTER the retire: dead-lettered, and the episode is already retired, so Keep again cannot rebuild the Memory", async () => {
    app = await start();
    const { memoryId, episodeId } = await keepEvening(app);
    _setTestClient(makeClient(app.store, { failWrites: new Set(["memory_evidence:delete"]) }) as any, true);
    assert.equal((await call(app, "DELETE", `/api/memories/${memoryId}`)).status, 204, "the deletion itself is not undone by a cleanup failure");
    const report = lifecycleReport(app);
    const purge = step(report, "RAW_EVIDENCE_PURGED");
    assert.deepEqual([purge.outcome, purge.retryable], ["failed", true]);
    assert.equal(report.deadLettered, true);
    assert.equal(app.store.memory_episodes.find((e) => e.id === episodeId).state, "deleted", "retired before the purge was attempted");

    _setTestClient(makeClient(app.store) as any, true);
    const keep = await call(app, "POST", `/api/me/memory-candidates/${episodeId}/confirm`, {});
    assert.equal(keep.status, 409);
    assert.equal(app.store.memories.find((x) => x.id === memoryId).state, "deleted");
  });

  it("the retire fails: NOTHING is purged, so a retry still finds the link and finishes the job", async () => {
    app = await start();
    const { memoryId, episodeId } = await keepEvening(app);
    const sc = makeClient(app.store, { failWrites: new Set(["memory_episodes:update"]) });
    _setTestClient(sc as any, true);
    assert.equal((await call(app, "DELETE", `/api/memories/${memoryId}`)).status, 204);
    assert.equal(step(lifecycleReport(app), "RAW_EVIDENCE_PURGED").outcome, "failed");
    assert.equal(evidenceOf(app, episodeId).length, 4, "the link that leads back to the episode is still there");

    const retry = await runMemoryDeletionLifecycle(makeClient(app.store) as any, {
      memoryId, ownerId: OWNER, actorUserId: OWNER, previous: { visibility: "only_me", state: "published" },
      now: new Date("2026-10-07T12:00:00.000Z"),
    });
    const purge = step(retry, "RAW_EVIDENCE_PURGED");
    assert.deepEqual([purge.outcome, purge.facts.purged, purge.facts.episodesRetired], ["done", 4, 1]);
    assert.deepEqual(evidenceOf(app, episodeId), []);
    assert.equal(app.store.memory_episodes.find((e) => e.id === episodeId).state, "deleted");
  });

  it("an interrupted Keep, then the Memory deleted, then Keep again: refused — no link, no photo, and the episode retired", async () => {
    app = await start();
    assert.equal((await detect(app)).status, 200);
    const ep = evening(app);
    // Keep is cut off after the Memory exists and before the link is written.
    _setTestClient(makeClient(app.store, { failWrites: new Set(["memory_evidence:upsert"]) }) as any, true);
    const cut = await call(app, "POST", `/api/me/memory-candidates/${ep.id}/confirm`, {});
    assert.equal(cut.status, 503);
    const made = app.store.memories.find((x) => x.owner_id === OWNER && x.id !== PLAIN_MEMORY);
    assert.ok(made, "precondition: the Memory exists without its link");
    _setTestClient(makeClient(app.store) as any, true);
    assert.equal((await call(app, "DELETE", `/api/memories/${made.id}`)).status, 204);
    const itemsBefore = app.store.memory_items.filter((i) => i.memory_id === made.id).length;

    const keep = await call(app, "POST", `/api/me/memory-candidates/${ep.id}/confirm`, {});
    assert.equal(keep.status, 409, JSON.stringify(keep.body));
    assert.equal(app.store.memories.find((x) => x.id === made.id).state, "deleted");
    assert.equal(app.store.memory_items.filter((i) => i.memory_id === made.id).length, itemsBefore, "no photo is attached to a deleted Memory");
    assert.deepEqual(evidenceOf(app, ep.id), [], "no link to a deleted Memory, and the captures are purged");
    assert.equal(app.store.memory_episodes.find((e) => e.id === ep.id).state, "deleted");
  });
});

describe("§21 dead letters are DURABLE (migration 3670) — census H193", () => {
  const letterOf = (a: App, memoryId: string) => (a.store.memory_deletion_dead_letters ?? []).find((r) => r.memory_id === memoryId);
  const runAt = (a: App, memoryId: string, iso: string, opts: FakeOpts = {}) =>
    runMemoryDeletionLifecycle(makeClient(a.store, opts) as any, {
      memoryId, ownerId: OWNER, actorUserId: OWNER, previous: { visibility: "only_me", state: "published" }, now: new Date(iso),
    });

  it("a dead-lettered deletion is WRITTEN: the failed step, how far it got, the attempts — and nothing the Memory said", async () => {
    app = await start();
    const { memoryId } = await keepEvening(app);
    _setTestClient(makeClient(app.store, { failWrites: new Set(["memory_evidence:delete"]) }) as any, true);
    assert.equal((await call(app, "DELETE", `/api/memories/${memoryId}`)).status, 204);
    const report = lifecycleReport(app);
    assert.equal(report.deadLettered, true);
    assert.equal(report.deadLetterDurable, true, report.deadLetterDetail);
    const letter = letterOf(app, memoryId);
    assert.ok(letter, "the dead letter is a row, not only a log line");
    assert.deepEqual([letter.owner_id, letter.failed_steps, letter.reached_state, letter.letters, letter.resolved_at],
      [OWNER, ["RAW_EVIDENCE_PURGED"], "DERIVATIVES_PURGED", 1, null]);
    assert.match(letter.detail, /RAW_EVIDENCE_PURGED ×3: memory_evidence purge/);
    assert.ok(!letter.detail.includes("Fado night"), "a dead letter carries no Memory content");
    assert.equal(letter.lifecycle_version, report.version);
  });

  it("a repeat dead letter for the same Memory bumps the count and keeps the first failure's time; a later run that completes resolves it", async () => {
    app = await start();
    const { memoryId } = await keepEvening(app);
    // The route's soft delete, which the lifecycle runs after.
    app.store.memories.find((x) => x.id === memoryId).state = "deleted";
    const fail = { failWrites: new Set(["memory_evidence:delete"]) };
    const first = await runAt(app, memoryId, "2026-10-07T10:00:00.000Z", fail);
    assert.equal(first.deadLetterDurable, true);
    const second = await runAt(app, memoryId, "2026-10-07T11:00:00.000Z", fail);
    assert.equal(second.deadLetterDurable, true);
    const letter = letterOf(app, memoryId);
    assert.deepEqual([letter.letters, letter.first_failed_at, letter.last_failed_at, letter.resolved_at],
      [2, "2026-10-07T10:00:00.000Z", "2026-10-07T11:00:00.000Z", null]);
    assert.equal(app.store.memory_deletion_dead_letters.length, 1, "one row per Memory");

    const healed = await runAt(app, memoryId, "2026-10-07T12:00:00.000Z");
    assert.equal(healed.completed, true);
    assert.equal(letterOf(app, memoryId).resolved_at, "2026-10-07T12:00:00.000Z");
  });

  it("3670 not applied: the deletion still answers 204, and the report says the dead letter is NOT durable and why", async () => {
    app = await start();
    const { memoryId } = await keepEvening(app);
    _setTestClient(makeClient(app.store, { absent: new Set(["memory_deletion_dead_letters"]), failWrites: new Set(["memory_evidence:delete"]) }) as any, true);
    assert.equal((await call(app, "DELETE", `/api/memories/${memoryId}`)).status, 204);
    const report = lifecycleReport(app);
    assert.deepEqual([report.deadLettered, report.deadLetterDurable], [true, false]);
    assert.match(report.deadLetterDetail, /memory_deletion_dead_letters is not deployed \(3670 unapplied\)/);
    assert.ok(app.logs.some((l) => /could NOT be recorded/.test(l.msg)), "the log line says it is the only record");
  });

  it("a dead-letter write that fails is reported as not durable — never as recorded", async () => {
    app = await start();
    const { memoryId } = await keepEvening(app);
    app.store.memories.find((x) => x.id === memoryId).state = "deleted";
    const report = await runAt(app, memoryId, "2026-10-07T10:00:00.000Z",
      { failWrites: new Set(["memory_evidence:delete", "memory_deletion_dead_letters:upsert"]) });
    assert.deepEqual([report.deadLettered, report.deadLetterDurable], [true, false]);
    assert.match(report.deadLetterDetail, /write failed/);
    assert.equal(letterOf(app, memoryId), undefined);
  });

  it("a deletion that completes writes no dead letter", async () => {
    app = await start();
    const { memoryId } = await keepEvening(app);
    assert.equal((await call(app, "DELETE", `/api/memories/${memoryId}`)).status, 204);
    const report = lifecycleReport(app);
    assert.deepEqual([report.completed, report.deadLettered, report.deadLetterDurable, report.deadLetterDetail], [true, false, false, ""]);
    assert.equal(letterOf(app, memoryId), undefined);
  });
});

describe("the redrive pass re-runs dead-lettered deletions (memory_deletion_redrive_enabled, 3670) — H193", () => {
  const FLAG_ON = { flag: "memory_deletion_redrive_enabled", enabled: true };
  const letterOf = (a: App, memoryId: string) => (a.store.memory_deletion_dead_letters ?? []).find((r) => r.memory_id === memoryId);
  /** Keep the evening, delete it with a purge that fails, so its deletion dead-letters. */
  async function deadLettered(): Promise<{ memoryId: string; episodeId: string }> {
    app = await start();
    const kept = await keepEvening(app);
    _setTestClient(makeClient(app.store, { failWrites: new Set(["memory_evidence:delete"]) }) as any, true);
    assert.equal((await call(app, "DELETE", `/api/memories/${kept.memoryId}`)).status, 204);
    assert.ok(letterOf(app, kept.memoryId), "precondition: an open dead letter");
    return kept;
  }

  it("flag OFF (the seed): one flag read and nothing else — the letter stays open, nothing is re-run", async () => {
    const { memoryId, episodeId } = await deadLettered();
    const before = JSON.stringify([app!.store.memory_evidence, app!.store.memory_deletion_dead_letters]);
    const out = await runMemoryDeletionRedrivePass({ client: makeClient(app!.store), now: new Date("2026-10-07T13:00:00.000Z") });
    assert.deepEqual([out.skipped, out.reason], [true, "disabled"]);
    assert.equal(JSON.stringify([app!.store.memory_evidence, app!.store.memory_deletion_dead_letters]), before);
    assert.ok(evidenceOf(app!, episodeId).length > 0);
    assert.equal(letterOf(app!, memoryId).resolved_at, null);
  });

  it("flag ON: a still-deleted Memory's deletion is re-run to completion, its evidence purged and its letter resolved", async () => {
    const { memoryId, episodeId } = await deadLettered();
    app!.store.feature_flags.push(FLAG_ON);
    const out = await runMemoryDeletionRedrivePass({ client: makeClient(app!.store), now: new Date("2026-10-07T13:00:00.000Z") });
    assert.deepEqual([out.considered, out.resolved, out.stillFailing, out.moot], [1, 1, 0, 0]);
    assert.deepEqual(evidenceOf(app!, episodeId), []);
    assert.equal(letterOf(app!, memoryId).resolved_at, "2026-10-07T13:00:00.000Z");
  });

  it("flag ON, still failing: the letter stays open and its count goes up", async () => {
    const { memoryId } = await deadLettered();
    app!.store.feature_flags.push(FLAG_ON);
    const out = await runMemoryDeletionRedrivePass({ client: makeClient(app!.store, { failWrites: new Set(["memory_evidence:delete"]) }), now: new Date("2026-10-07T13:00:00.000Z") });
    assert.deepEqual([out.resolved, out.stillFailing], [0, 1]);
    assert.deepEqual([letterOf(app!, memoryId).letters, letterOf(app!, memoryId).resolved_at], [2, null]);
  });

  it("a letter whose Memory is NOT deleted is closed as moot, and no deletion step runs against a live Memory", async () => {
    const { memoryId, episodeId } = await deadLettered();
    app!.store.feature_flags.push(FLAG_ON);
    app!.store.memories.find((x) => x.id === memoryId).state = "published"; // restored by support
    const evidenceBefore = JSON.stringify(evidenceOf(app!, episodeId));
    const out = await runMemoryDeletionRedrivePass({ client: makeClient(app!.store), now: new Date("2026-10-07T13:00:00.000Z") });
    assert.deepEqual([out.moot, out.resolved, out.stillFailing], [1, 0, 0]);
    assert.equal(JSON.stringify(evidenceOf(app!, episodeId)), evidenceBefore, "nothing was purged for a live Memory");
    const letter = letterOf(app!, memoryId);
    assert.equal(letter.resolved_at, "2026-10-07T13:00:00.000Z");
    assert.match(letter.detail, /moot: the Memory is 'published', not deleted/);
  });

  it("3670 not applied: `not_deployed`, and nothing else is read", async () => {
    app = await start({ absent: new Set(["memory_deletion_dead_letters"]) });
    app.store.feature_flags.push(FLAG_ON);
    const out = await runMemoryDeletionRedrivePass({ client: makeClient(app.store, { absent: new Set(["memory_deletion_dead_letters"]) }) });
    assert.deepEqual([out.skipped, out.reason], [true, "not_deployed"]);
  });
});
