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
import { candidateMemoryId, confirmCandidate } from "../services/memory/episodeCandidates.js";
import { eraseEvidenceForMemory, retireEpisodesAndPurgeEvidence, RETIRED_EPISODE_CLEARED } from "../services/memory/memoryEvidenceErasure.js";
import { acknowledgeEpisodeCheckpoint, readRetryDetail, saveEpisodeCheckpoint, MAX_EPISODE_CHECKPOINTS } from "../services/memory/memoryDeletionDeadLetters.js";
import { runMemoryDeletionLifecycle } from "../services/memory/memoryDeletionLifecycle.js"; import { runMemoryDeletionRedrivePass } from "../lib/memoryDeletionRedriveScheduler.js"; // one line: the census cites this file by line

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

type FakeReadResult = { data: unknown; error: unknown };

interface FakeOpts {
  absent?: Set<string>;
  absentCode?: "42P01" | "PGRST205";
  failWrites?: Set<string>;
  failReads?: Set<string>;
  evidenceLinkRead?: (rows: any[]) => FakeReadResult | Promise<FakeReadResult>;
  deadLetterDetailRead?: (rows: any[]) => { data: unknown; error: unknown };
  deadLetterSnapshotRead?: (rows: any[]) => FakeReadResult;
  beforeDeadLetterWrite?: (mode: string, payload: any) => Promise<void>;
  retainEvidenceOnDelete?: boolean;
  retireMutation?: (rows: any[], payload: any) => FakeReadResult;
  purgeMutation?: (rows: any[]) => FakeReadResult;
  memoryRead?: (table: string, selected: string | undefined, rows: any[], single: boolean) => FakeReadResult | undefined;
  deadLetterMutationResponse?: (mode: string, payload: any, rows: any[]) => FakeReadResult | undefined;
}

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
    let selected: string | undefined;
    const f = (c: string, p: (r: any) => boolean) => { named.push(c); filters.push(p); return obj; };
    const obj: any = {
      select(columns?: string) { selected = columns; if (mode !== "select") wantRows = true; return obj; },
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
      if (opts.absent?.has(table)) return err(`relation "public.${table}" does not exist`, opts.absentCode ?? "42P01");
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
      if (mode !== "select" && opts.failWrites?.has(`${table}:${mode}`)) return err(`${table} ${mode} failed`, "57014"); if (mode === "select" && opts.failReads?.has(table)) return err(`${table} read failed`, "57014");
      if (table === "memory_deletion_dead_letters" && mode !== "select") await opts.beforeDeadLetterWrite?.(mode, payload);
      const all = store[table] ?? [];
      if (mode !== "select" && !store[table]) store[table] = all;
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
              if (mode === "upsert" && upsertOpts.onConflict === "memory_id") {
                if (upsertOpts.ignoreDuplicates) continue;
                Object.assign(had, r);
                written.push(had);
                continue;
              }
              return err("duplicate key value violates unique constraint \"memory_deletion_dead_letters_pkey\"", "23505");
            }
          } else {
            if (r.id != null && all.some((x) => x.id === r.id)) return err(`duplicate key value violates unique constraint "${table}_pkey"`, "23505");
            r.id = r.id ?? newId();
          }
          all.push(r);
          written.push(r);
        }
        if (table === "memory_deletion_dead_letters") {
          const response = opts.deadLetterMutationResponse?.(mode, payload, written);
          if (response !== undefined) return response;
        }
        if (!wantRows) return { data: null, error: null };
        return { data: single ? written[0] ?? null : written, error: null };
      }
      let matched = all.filter((r) => filters.every((p) => p(r)));
      if (mode === "delete") {
        if (table === "memory_evidence" && opts.purgeMutation) return opts.purgeMutation(matched);
        if (!(table === "memory_evidence" && opts.retainEvidenceOnDelete)) store[table] = all.filter((r) => !matched.includes(r));
        return { data: wantRows ? matched.map((r) => ({ ...r })) : null, error: null };
      }
      if (mode === "update") {
        if (table === "memory_episodes" && payload?.state === "deleted" && opts.retireMutation) return opts.retireMutation(matched, payload);
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
        if (table === "memory_deletion_dead_letters") {
          const response = opts.deadLetterMutationResponse?.(mode, payload, matched);
          if (response !== undefined) return response;
        }
        if (!wantRows) return { data: null, error: null };
        return { data: matched.map((r) => ({ ...r })), error: null };
      }
      if (orderBy) {
        const { col, asc } = orderBy;
        matched = [...matched].sort((a, b) => (String(a[col] ?? "") < String(b[col] ?? "") ? -1 : String(a[col] ?? "") > String(b[col] ?? "") ? 1 : 0) * (asc ? 1 : -1));
      }
      if (limitN != null) matched = matched.slice(0, limitN);
      if ((table === "memory_episodes" || table === "memory_evidence") && opts.memoryRead) {
        const result = opts.memoryRead(table, selected, matched, single);
        if (result !== undefined) return result;
      }
      if (table === "memory_evidence" && selected === "episode_id" && opts.evidenceLinkRead) return opts.evidenceLinkRead(matched);
      if (table === "memory_deletion_dead_letters" && selected === "detail" && opts.deadLetterDetailRead) return opts.deadLetterDetailRead(matched);
      if (table === "memory_deletion_dead_letters" && selected?.includes("owner_id") && selected.includes("letters") && selected.includes("detail") && opts.deadLetterSnapshotRead) return opts.deadLetterSnapshotRead(matched.map((row) => ({ ...row })));
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

describe("Keep terminal Memory refusal", () => {
  const now = new Date("2026-10-16T00:00:00.000Z");
  const episodeId = "e7777777-0000-4000-8000-000000000000";
  const input = { ownerId: OWNER, episodeId, title: null, idempotencyKey: "terminal-keep", now };

  function fixture(store: Record<string, any[]>, state: string, linked: boolean, sourceMode = "LEGACY_IMPORTED") {
    const memoryId = candidateMemoryId(episodeId);
    const episode = { ...store.memory_episodes[0], id: episodeId, user_id: OWNER };
    const memory = { ...store.memories[0], id: memoryId, state, source_mode: sourceMode };
    store.memory_episodes.push(episode);
    store.memories.push(memory);
    store.memory_evidence.push({
      id: newId(), episode_id: episodeId, user_id: OWNER, truth_level: "observed", source_class: "system",
      source_table: "media_assets", source_id: m(1), source_ref: {}, observed_at: now.toISOString(), weight: 0.7,
    });
    if (linked) store.memory_evidence.push({
      id: newId(), episode_id: episodeId, user_id: OWNER, truth_level: "asserted", source_class: "explicit",
      source_table: "memories", source_id: memoryId, source_ref: { confirmed_by: "owner" }, observed_at: now.toISOString(), weight: 1,
    });
    return { memoryId, episode, memory };
  }

  for (const state of ["deleted", "removed"]) for (const linked of [false, true]) for (const kernel of [false, true]) {
    it(`service refuses ${state}, ${linked ? "linked" : "interrupted"}, kernel ${kernel ? "on" : "off"} before linking or attaching`, async () => {
      resetHighlightSchemaMemo();
      const store = seed();
      const { memoryId, episode, memory } = fixture(store, state, linked);
      const original = structuredClone(memory);
      store.feature_flags.push({ flag: "memory_kernel_enabled", enabled: kernel });
      const client = makeClient(store);
      const commands: string[] = [];
      const service = {
        ...client,
        rpc: async (name: string, args: any) => {
          commands.push(args.p_command.type);
          assert.equal(name, "memory_kernel_execute");
          assert.equal(args.p_command.type, "CREATE_MEMORY");
          return { error: null, data: {
            ok: true, duplicate: true, memory_id: memoryId, event_id: "f7777777-0000-4000-8000-000000000000",
            event_type: "memory.created", result: { id: memoryId }, contract_version: 1,
          } };
        },
      };
      const result = await confirmCandidate(service as any, input);
      assert.equal(result.ok, false, JSON.stringify(result));
      if (!result.ok) assert.equal(result.reason, "not_a_candidate");
      assert.deepEqual(memory, original);
      assert.deepEqual(store.memory_items, []);
      assert.deepEqual(store.memory_evidence, []);
      assert.equal(episode.state, "deleted");
      assert.deepEqual(commands, kernel && !linked ? ["CREATE_MEMORY"] : []);
    });
  }

  for (const state of ["deleted", "removed"]) for (const linked of [false, true]) {
    it(`router refuses ${state}, ${linked ? "linked" : "interrupted"} with 409 and no kept result`, async () => {
      app = await start();
      const { memory, episode } = fixture(app.store, state, linked);
      const original = structuredClone(memory);
      const result = await call(app, "POST", `/api/me/memory-candidates/${episodeId}/confirm`, {});
      assert.equal(result.status, 409, JSON.stringify(result.body));
      assert.equal(result.body.reason, "not_a_candidate");
      assert.equal(result.body.memoryId, undefined);
      assert.deepEqual(memory, original);
      assert.deepEqual(app.store.memory_items, []);
      assert.deepEqual(app.store.memory_evidence, []);
      assert.equal(episode.state, "deleted");
    });
  }

  for (const sourceMode of ["LEGACY_IMPORTED", "USER_CREATED"]) for (const linked of [false, true]) {
    it(`preserves surviving ${sourceMode}, ${linked ? "linked" : "interrupted"} retries without relabelling or duplicates`, async () => {
      resetHighlightSchemaMemo();
      const store = seed();
      const { memoryId, memory } = fixture(store, "published", linked, sourceMode);
      const client = makeClient(store);
      for (let attempt = 0; attempt < 2; attempt++) {
        const result = await confirmCandidate(client as any, input);
        assert.equal(result.ok, true, JSON.stringify(result));
        if (result.ok && "memoryId" in result) assert.equal(result.memoryId, memoryId);
        assert.equal(memory.source_mode, sourceMode);
      }
      assert.equal(store.memories.length, 2);
      assert.equal(store.memory_items.filter(row => row.memory_id === memoryId).length, 1);
      assert.equal(store.memory_evidence.filter(row => row.source_table === "memories" && row.source_id === memoryId).length, 1);
    });
  }

  it("refuses a missing Memory when its existing evidence link establishes the association", async () => {
    resetHighlightSchemaMemo();
    const store = seed();
    const { memoryId, episode } = fixture(store, "published", true);
    store.memories = store.memories.filter(row => row.id !== memoryId);
    const result = await confirmCandidate(makeClient(store) as any, input);
    assert.equal(result.ok, false, JSON.stringify(result));
    if (!result.ok) assert.equal(result.reason, "not_a_candidate");
    assert.equal(episode.state, "deleted");
    assert.deepEqual(store.memory_evidence, []);
    assert.deepEqual(store.memory_items, []);
    assert.equal(store.memories.length, 1);
  });

  describe("canonical guard", () => {
    function typedFixture(state: string, linked: boolean, kernel: boolean, enabled: boolean | undefined) {
      resetHighlightSchemaMemo();
      const store = seed();
      const kept = fixture(store, state, linked);
      Object.assign(kept.memory, {
        memory_type: "MOMENT", title: "Owner title", caption: "Owner caption",
        place_display_name_at_occurrence: "Owner place", location_city: "Lisbon",
      });
      store.feature_flags.push({ flag: "memory_kernel_enabled", enabled: kernel });
      if (enabled !== undefined) store.feature_flags.push({ flag: "memory_type_enabled", enabled });
      return { store, ...kept };
    }

    function serviceFor(store: Record<string, any[]>, memoryId: string, options: FakeOpts = {}) {
      const base = makeClient(store, options);
      const commands: string[] = [];
      const reads: Array<{ table: string; columns: string | undefined }> = [];
      const service = {
        ...base,
        from: (table: string) => {
          const query = base.from(table);
          const select = query.select;
          query.select = (columns?: string) => {
            reads.push({ table, columns });
            return select(columns);
          };
          return query;
        },
        rpc: async (name: string, args: any) => {
          assert.equal(name, "memory_kernel_execute");
          const command = args.p_command;
          commands.push(command.type);
          let resultId = memoryId;
          let duplicate = true;
          if (command.type === "CREATE_MEMORY") {
            if (!store.memories.some(row => row.id === memoryId)) {
              store.memories.push({ ...command.payload.write, memory_type: "MOMENT" });
              duplicate = false;
            }
          } else {
            assert.equal(command.type, "ADD_MEDIA");
            const item = command.payload.write;
            resultId = item.id;
            if (!store.memory_items.some(row => row.id === item.id)) {
              store.memory_items.push({ ...item });
              duplicate = false;
            }
          }
          return { error: null, data: {
            ok: true, duplicate, memory_id: memoryId, event_id: "f7777777-0000-4000-8000-000000000000",
            event_type: command.type === "CREATE_MEMORY" ? "memory.created" : "memory.media_added",
            result: { id: resultId }, contract_version: 1,
          } };
        },
      };
      return { service, commands, reads };
    }

    for (const state of ["deleted", "removed"]) for (const linked of [false, true]) for (const kernel of [false, true]) for (const enabled of [false, true]) {
      it(`preserves every Memory field on ${state}, linked=${linked}, kernel=${kernel}, types=${enabled}`, async () => {
        const { store, memoryId, memory, episode } = typedFixture(state, linked, kernel, enabled);
        const original = structuredClone(memory);
        const { service, commands } = serviceFor(store, memoryId);
        const result = await confirmCandidate(service as any, input);
        assert.equal(result.ok, false, JSON.stringify(result));
        if (!result.ok) assert.equal(result.reason, "not_a_candidate");
        assert.deepEqual(memory, original);
        assert.equal(episode.state, "deleted");
        assert.deepEqual(store.memory_items, []);
        assert.deepEqual(store.memory_evidence, []);
        assert.deepEqual(commands, kernel && !linked ? ["CREATE_MEMORY"] : []);
        const receipt = store.memory_deletion_dead_letters.find(row => row.memory_id === memoryId);
        assert.equal(receipt.owner_id, OWNER);
        const detail = readRetryDetail(receipt.detail);
        assert.equal(detail.ok, true);
        if (detail.ok) assert.deepEqual(detail.checkpoints, []);
      });
    }

    for (const linked of [false, true]) for (const kernel of [false, true]) for (const enabled of [false, true]) {
      it(`preserves surviving reconciliation and retry, linked=${linked}, kernel=${kernel}, types=${enabled}`, async () => {
        const { store, memoryId, memory } = typedFixture("published", linked, kernel, enabled);
        const { service, commands } = serviceFor(store, memoryId);
        for (let attempt = 0; attempt < 2; attempt++) {
          const result = await confirmCandidate(service as any, input);
          assert.equal(result.ok, true, JSON.stringify(result));
          assert.equal(memory.memory_type, linked ? "MOMENT" : "EPISODE");
          assert.deepEqual([memory.source_mode, memory.title, memory.caption], ["LEGACY_IMPORTED", "Owner title", "Owner caption"]);
        }
        assert.equal(store.memories.length, 2);
        assert.equal(store.memory_items.filter(row => row.memory_id === memoryId).length, 1);
        assert.equal(store.memory_evidence.filter(row => row.source_table === "memories" && row.source_id === memoryId).length, 1);
        assert.deepEqual(commands, kernel ? linked ? ["ADD_MEDIA"] : ["CREATE_MEMORY", "ADD_MEDIA"] : []);
      });
    }

    for (const kernel of [false, true]) for (const enabled of [false, true]) {
      it(`new Memory still ends EPISODE, kernel=${kernel}, types=${enabled}`, async () => {
        const { store, memoryId } = typedFixture("published", false, kernel, enabled);
        store.memories = store.memories.filter(row => row.id !== memoryId);
        const { service } = serviceFor(store, memoryId);
        const result = await confirmCandidate(service as any, input);
        assert.equal(result.ok, true, JSON.stringify(result));
        assert.equal(store.memories.find(row => row.id === memoryId).memory_type, "EPISODE");
        assert.equal(store.memories.length, 2);
        assert.equal(store.memory_items.filter(row => row.memory_id === memoryId).length, 1);
      });

      it(`canonical write failure stays unavailable and retries without duplicates, kernel=${kernel}, types=${enabled}`, async () => {
        const { store, memoryId, memory } = typedFixture("published", false, kernel, enabled);
        const failed = serviceFor(store, memoryId, { failWrites: new Set(["memories:update"]) });
        const refused = await confirmCandidate(failed.service as any, input);
        assert.equal(refused.ok, false);
        if (!refused.ok) {
          assert.equal(refused.reason, "unavailable");
          assert.match(refused.detail, /canonical fields write failed/);
        }
        assert.equal(memory.memory_type, "MOMENT");
        assert.equal(store.memory_evidence.some(row => row.source_table === "memories"), false);
        assert.deepEqual(store.memory_items, []);
        const healthy = serviceFor(store, memoryId);
        assert.equal((await confirmCandidate(healthy.service as any, input)).ok, true);
        assert.equal(memory.memory_type, "EPISODE");
        assert.equal(store.memories.length, 2);
        assert.equal(store.memory_items.length, 1);
      });

      it(`owner-state read failure precedes reconciliation, kernel=${kernel}, types=${enabled}`, async () => {
        const { store, memoryId, memory } = typedFixture("published", false, kernel, enabled);
        const original = structuredClone(memory);
        const { service } = serviceFor(store, memoryId);
        const from = service.from;
        service.from = (table: string) => {
          const query = from(table);
          const select = query.select;
          query.select = (columns?: string) => {
            const selected = select(columns);
            if (table === "memories" && columns === "id, state") {
              selected.maybeSingle = async () => ({ data: null, error: { code: "57014", message: "owner-state read failed" } });
            }
            return selected;
          };
          return query;
        };
        const result = await confirmCandidate(service as any, input);
        assert.equal(result.ok, false);
        if (!result.ok) {
          assert.equal(result.reason, "unavailable");
          assert.match(result.detail, /owner-state read failed/);
        }
        assert.deepEqual(memory, original);
        assert.equal(store.memory_evidence.some(row => row.source_table === "memories"), false);
        assert.deepEqual(store.memory_items, []);
      });

      it(`foreign owner refuses before canonical reads, kernel=${kernel}, types=${enabled}`, async () => {
        const { store, memoryId, memory } = typedFixture("published", false, kernel, enabled);
        memory.owner_id = OTHER;
        const original = structuredClone(memory);
        const { service, reads } = serviceFor(store, memoryId);
        const result = await confirmCandidate(service as any, input);
        assert.equal(result.ok, false);
        assert.deepEqual(memory, original);
        assert.equal(reads.some(read => read.table === "memories" && read.columns?.includes("memory_type")), false);
        assert.deepEqual(store.memory_items, []);
      });
    }

    for (const state of ["deleted", "removed"]) for (const kernel of [false, true]) {
      it(`absent type flag preserves terminal metadata, state=${state}, kernel=${kernel}`, async () => {
        const { store, memoryId, memory } = typedFixture(state, false, kernel, undefined);
        const original = structuredClone(memory);
        const { service } = serviceFor(store, memoryId);
        const result = await confirmCandidate(service as any, input);
        assert.equal(result.ok, false);
        if (!result.ok) assert.equal(result.reason, "not_a_candidate");
        assert.deepEqual(memory, original);
        assert.deepEqual(store.memory_items, []);
      });
    }
  });
});

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
    app = await start({ absent: new Set(["memory_evidence", "memory_episodes", "memory_corrections"]) }); // H-13: step 4 also targets 3673, so "not deployed" means neither store is
    assert.equal((await call(app, "DELETE", `/api/memories/${PLAIN_MEMORY}`)).status, 204);
    const report = lifecycleReport(app);
    const purge = step(report, "RAW_EVIDENCE_PURGED");
    assert.equal(purge.outcome, "not_applicable");
    assert.equal(purge.attempts, 1);
    assert.match(purge.detail, /memory_evidence is not deployed/); assert.match(purge.detail, /memory_corrections is not deployed/);
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

  it("a deletion that completes leaves a resolved checkpoint receipt, not an open failure", async () => {
    app = await start();
    const { memoryId } = await keepEvening(app);
    assert.equal((await call(app, "DELETE", `/api/memories/${memoryId}`)).status, 204);
    const report = lifecycleReport(app);
    assert.deepEqual([report.completed, report.deadLettered, report.deadLetterDurable, report.deadLetterDetail], [true, false, false, ""]);
    assert.notEqual(letterOf(app, memoryId).resolved_at, null);
    const detail = readRetryDetail(letterOf(app, memoryId).detail);
    assert.equal(detail.ok, true);
    if (detail.ok) assert.deepEqual(detail.checkpoints, []);
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

describe("verifier findings F1-F5 (VERIFY-H-45bca4a1c6)", () => {
  const letterOf = (a: App, memoryId: string) => (a.store.memory_deletion_dead_letters ?? []).find((r) => r.memory_id === memoryId);
  const runAt = (a: App, memoryId: string, iso: string, opts: FakeOpts = {}) =>
    runMemoryDeletionLifecycle(makeClient(a.store, opts) as any, {
      memoryId, ownerId: OWNER, actorUserId: OWNER, previous: { visibility: "only_me", state: "published" }, now: new Date(iso),
    });

  it("F1: the link read FAILS (not absent): step 4 is a retryable failure, retried to the cap and dead-lettered — never `done` with nothing purged", async () => {
    app = await start();
    const { memoryId, episodeId } = await keepEvening(app);
    _setTestClient(makeClient(app.store, { failReads: new Set(["memory_evidence"]) }) as any, true);
    assert.equal((await call(app, "DELETE", `/api/memories/${memoryId}`)).status, 204);
    const report = lifecycleReport(app);
    const purge = step(report, "RAW_EVIDENCE_PURGED");
    assert.deepEqual([purge.outcome, purge.retryable, purge.attempts], ["failed", true, 3]);
    assert.match(purge.detail, /memory_evidence link read/);
    assert.equal(report.deadLettered, true);
    assert.equal(evidenceOf(app, episodeId).length, 4, "nothing was claimed purged");
    assert.deepEqual(letterOf(app, memoryId).failed_steps, ["RAW_EVIDENCE_PURGED"]);
  });

  it("F2: a Keep whose Memory read FAILS is refused 503 — no link row and no photo is written", async () => {
    app = await start();
    assert.equal((await detect(app)).status, 200);
    const ep = evening(app);
    _setTestClient(makeClient(app.store, { failReads: new Set(["memories"]) }) as any, true);
    const keep = await call(app, "POST", `/api/me/memory-candidates/${ep.id}/confirm`, {});
    assert.equal(keep.status, 503, JSON.stringify(keep.body));
    assert.equal(evidenceOf(app, ep.id).filter((v) => v.source_table === "memories").length, 0, "no link to a Memory whose state could not be read");
    const made = app.store.memories.find((x) => x.owner_id === OWNER && x.id !== PLAIN_MEMORY);
    assert.equal(app.store.memory_items.filter((i) => i.memory_id === made?.id).length, 0, "no photo attached");
  });

  it("F3: interrupted Keep → DELETE → Keep with the purge failing: the episode stays `confirmed` with its captures, and the next Keep purges and retires — nothing is orphaned", async () => {
    app = await start();
    assert.equal((await detect(app)).status, 200);
    const ep = evening(app);
    _setTestClient(makeClient(app.store, { failWrites: new Set(["memory_evidence:upsert"]) }) as any, true);
    assert.equal((await call(app, "POST", `/api/me/memory-candidates/${ep.id}/confirm`, {})).status, 503);
    const made = app.store.memories.find((x) => x.owner_id === OWNER && x.id !== PLAIN_MEMORY);
    _setTestClient(makeClient(app.store) as any, true);
    assert.equal((await call(app, "DELETE", `/api/memories/${made.id}`)).status, 204);

    _setTestClient(makeClient(app.store, { failWrites: new Set(["memory_evidence:delete"]) }) as any, true);
    assert.equal((await call(app, "POST", `/api/me/memory-candidates/${ep.id}/confirm`, {})).status, 503);
    assert.equal(app.store.memory_episodes.find((e) => e.id === ep.id).state, "confirmed", "not retired while its evidence could not be purged");
    assert.equal(evidenceOf(app, ep.id).length, 3, "the captures are still reachable from a live episode");
    _setTestClient(makeClient(app.store) as any, true);
    const inbox = await call(app, "GET", "/api/me/memory-candidates");
    assert.ok(inbox.body.candidates.some((c: any) => c.id === ep.id && c.state === "interrupted"), "the owner is still shown it, so it is retried");

    const again = await call(app, "POST", `/api/me/memory-candidates/${ep.id}/confirm`, {});
    assert.equal(again.status, 409, "refused by the deleted Memory, not by the episode state");
    assert.deepEqual(evidenceOf(app, ep.id), []);
    assert.equal(app.store.memory_episodes.find((e) => e.id === ep.id).state, "deleted");
    assert.equal(app.store.memories.find((x) => x.id === made.id).state, "deleted");
  });

  it("F4: a run that leaves the Memory published (DELETED fails, non-retryable) is RECORDED, and the redrive keeps it open for an operator without running a step", async () => {
    app = await start();
    const { memoryId, episodeId } = await keepEvening(app);
    const report = await runAt(app, memoryId, "2026-10-07T10:00:00.000Z");
    assert.deepEqual([report.completed, report.deadLettered, report.deadLetterDurable], [false, false, true]);
    const letter = letterOf(app, memoryId);
    assert.ok(letter.failed_steps.includes("DELETED"));
    assert.match(letter.detail, /still in state 'published'/);

    app.store.feature_flags.push({ flag: "memory_deletion_redrive_enabled", enabled: true });
    const evidenceBefore = JSON.stringify(evidenceOf(app, episodeId));
    const out = await runMemoryDeletionRedrivePass({ client: makeClient(app.store), now: new Date("2026-10-07T11:00:00.000Z") });
    assert.deepEqual([out.needsOperator, out.moot, out.resolved], [1, 0, 0]);
    assert.deepEqual([letterOf(app, memoryId).resolved_at, letterOf(app, memoryId).last_failed_at], [null, "2026-10-07T11:00:00.000Z"]);
    assert.equal(JSON.stringify(evidenceOf(app, episodeId)), evidenceBefore, "no deletion step ran against the published Memory");
  });

  it("M1: a link to a Memory row that no longer exists — Keep refuses and attaches nothing", async () => {
    app = await start();
    const { memoryId, episodeId } = await keepEvening(app);
    const itemsBefore = app.store.memory_items.length;
    app.store.memories = app.store.memories.filter((x) => x.id !== memoryId); // hard-deleted
    const keep = await call(app, "POST", `/api/me/memory-candidates/${episodeId}/confirm`, {});
    assert.equal(keep.status, 409, JSON.stringify(keep.body));
    assert.equal(app.store.memory_items.length, itemsBefore, "no photo attached to a Memory that is gone");
    assert.deepEqual(evidenceOf(app, episodeId), []);
  });

  it("M3: a completing run does not re-stamp a letter that is already resolved", async () => {
    app = await start();
    const { memoryId } = await keepEvening(app);
    app.store.memories.find((x) => x.id === memoryId).state = "deleted";
    await runAt(app, memoryId, "2026-10-07T10:00:00.000Z", { failWrites: new Set(["memory_evidence:delete"]) });
    await runAt(app, memoryId, "2026-10-07T11:00:00.000Z");
    assert.equal(letterOf(app, memoryId).resolved_at, "2026-10-07T11:00:00.000Z");
    const later = await runAt(app, memoryId, "2026-10-07T12:00:00.000Z");
    assert.equal(later.completed, true);
    assert.equal(letterOf(app, memoryId).resolved_at, "2026-10-07T11:00:00.000Z", "the first resolution is the record");
  });

  it("M2: a Memory linked from TWO episodes — both are retired and every row of both is purged", async () => {
    app = await start();
    const { memoryId, episodeId } = await keepEvening(app);
    const second = { ...app.store.memory_episodes.find((e) => e.id === episodeId), id: "e7777777-0000-4000-8000-000000000000", detection_digest: "second", started_at: "2026-03-04T10:00:00.000Z", ended_at: "2026-03-04T11:00:00.000Z" };
    app.store.memory_episodes.push(second);
    app.store.memory_evidence.push(
      { id: "f1000000-0000-4000-8000-000000000001", episode_id: second.id, user_id: OWNER, truth_level: "asserted", source_class: "explicit", source_table: "memories", source_id: memoryId, source_ref: {}, observed_at: null, recorded_at: "2026-10-07T00:00:00.000Z", weight: 1 },
      { id: "f1000000-0000-4000-8000-000000000002", episode_id: second.id, user_id: OWNER, truth_level: "observed", source_class: "system", source_table: "media_assets", source_id: m(4), source_ref: {}, observed_at: null, recorded_at: "2026-10-07T00:00:00.000Z", weight: 0.7 },
    );
    assert.equal((await call(app, "DELETE", `/api/memories/${memoryId}`)).status, 204);
    for (const id of [episodeId, second.id]) {
      assert.deepEqual(evidenceOf(app, id), [], `episode ${id} keeps no evidence`);
      assert.equal(app.store.memory_episodes.find((e) => e.id === id).state, "deleted");
    }
    assert.deepEqual([step(lifecycleReport(app), "RAW_EVIDENCE_PURGED").facts.purged, step(lifecycleReport(app), "RAW_EVIDENCE_PURGED").facts.episodesRetired], [6, 2]);
  });
});

describe("VERIFY-H2 — the redrive's untested branches (H2-1, H2-3, H2-5, the batch bound)", () => {
  const FLAG_ON = { flag: "memory_deletion_redrive_enabled", enabled: true };
  const letter = (memoryId: string, over: Record<string, unknown> = {}) => ({
    memory_id: memoryId, owner_id: OWNER, failed_steps: ["RAW_EVIDENCE_PURGED"], reached_state: "DERIVATIVES_PURGED",
    detail: "RAW_EVIDENCE_PURGED ×3: x", lifecycle_version: "memory-deletion@1", letters: 1,
    first_failed_at: "2026-10-07T09:00:00.000Z", last_failed_at: "2026-10-07T09:00:00.000Z", resolved_at: null, ...over,
  });

  it("H2-1: the Memory row is UNREADABLE — the letter is left open and untouched, and no step runs (a live Memory's derivatives are not revoked)", async () => {
    app = await start();
    app.store.feature_flags.push(FLAG_ON);
    app.store.memory_deletion_dead_letters = [letter(PLAIN_MEMORY)];
    app.store.memory_derivative_registry = [{ id: "reg-public", owner_id: OWNER, projection_id: "PublicMemoryProjection", scope_key: `PublicMemoryProjection|owner:${OWNER}`, source_memory_ids: [PLAIN_MEMORY], revocation_state: "ACTIVE", payload_json: [{ memory_id: PLAIN_MEMORY }], row_count: 1 }];
    const before = JSON.stringify([app.store.memory_deletion_dead_letters, app.store.memory_derivative_registry]);
    const out = await runMemoryDeletionRedrivePass({ client: makeClient(app.store, { failReads: new Set(["memories"]) }), now: new Date("2026-10-07T13:00:00.000Z") });
    assert.deepEqual([out.considered, out.unreadable, out.resolved, out.stillFailing, out.moot], [1, 1, 0, 0, 0]);
    assert.equal(JSON.stringify([app.store.memory_deletion_dead_letters, app.store.memory_derivative_registry]), before);
  });

  it("H2-3: a RESOLVED letter beside an open one — only the open one is considered, and the resolved one is untouched", async () => {
    app = await start();
    app.store.feature_flags.push(FLAG_ON);
    const resolved = letter("88888888-8888-4888-8888-888888888881", { resolved_at: "2026-10-07T10:00:00.000Z", last_failed_at: "2026-10-07T08:00:00.000Z" });
    app.store.memory_deletion_dead_letters = [resolved, letter(PLAIN_MEMORY)];
    const resolvedBefore = JSON.stringify(resolved);
    const out = await runMemoryDeletionRedrivePass({ client: makeClient(app.store), now: new Date("2026-10-07T13:00:00.000Z") });
    assert.equal(out.considered, 1);
    assert.equal(JSON.stringify(app.store.memory_deletion_dead_letters.find((l) => l.memory_id === resolved.memory_id)), resolvedBefore);
  });

  it("H2-5: a letter whose Memory is ARCHIVED is closed as moot — 'not deleted' is every state but deleted — and no step runs", async () => {
    app = await start();
    const { memoryId, episodeId } = await keepEvening(app);
    app.store.feature_flags.push(FLAG_ON);
    app.store.memories.find((x) => x.id === memoryId).state = "archived";
    app.store.memory_deletion_dead_letters = [letter(memoryId)];
    const evidenceBefore = JSON.stringify(evidenceOf(app, episodeId));
    const out = await runMemoryDeletionRedrivePass({ client: makeClient(app.store), now: new Date("2026-10-07T13:00:00.000Z") });
    assert.deepEqual([out.moot, out.resolved, out.stillFailing], [1, 0, 0]);
    assert.equal(JSON.stringify(evidenceOf(app, episodeId)), evidenceBefore);
    assert.match(app.store.memory_deletion_dead_letters[0].detail, /moot: the Memory is 'archived'/);
  });

  it("the batch is bounded: 30 open letters, 25 considered in one pass, the rest left for the next", async () => {
    app = await start();
    app.store.feature_flags.push(FLAG_ON);
    app.store.memory_deletion_dead_letters = Array.from({ length: 30 }, (_, i) =>
      letter(`99999999-9999-4999-8999-${String(i).padStart(12, "0")}`, { last_failed_at: `2026-10-07T09:${String(i).padStart(2, "0")}:00.000Z` }));
    for (const l of app.store.memory_deletion_dead_letters) app.store.memories.push({ id: l.memory_id, owner_id: OWNER, state: "published" });
    const out = await runMemoryDeletionRedrivePass({ client: makeClient(app.store), now: new Date("2026-10-07T13:00:00.000Z") });
    assert.deepEqual([out.considered, out.moot], [25, 25]);
    assert.equal(app.store.memory_deletion_dead_letters.filter((l) => l.resolved_at == null).length, 5);
  });
});

// ── Lead ruling H-13 (2026-10-07): a deleted Memory's place corrections (3673) ─
// are purged by §21 itself, in RAW_EVIDENCE_PURGED, not kept until the account
// goes. Appended: the census cites this file by line.
describe("H-13 — the §21 lifecycle purges a deleted Memory's corrections", () => {
  const LIVE_MEMORY = "90000000-0000-4000-8000-000000000002";
  const FLAG_ON = { flag: "memory_deletion_redrive_enabled", enabled: true };
  const correction = (memoryId: string, n: number, kind = "reject") => ({
    id: `c${n}000000-0000-4000-8000-000000000000`, memory_id: memoryId, owner_id: OWNER, field: "place", kind,
    place_id: `place-${n}`, canonical_location_id: null, source: "correction_route", created_at: `2026-10-07T00:00:0${n}.000Z`,
  });
  const seedCorrections = (a: App) => {
    a.store.memories.push({ ...a.store.memories[0], id: LIVE_MEMORY, title: "still here" });
    a.store.memory_corrections = [correction(PLAIN_MEMORY, 1), correction(PLAIN_MEMORY, 2, "assert"), correction(LIVE_MEMORY, 3)];
  };
  const correctionsOf = (a: App, memoryId: string) => (a.store.memory_corrections ?? []).filter((c) => c.memory_id === memoryId);
  const letterOf = (a: App, memoryId: string) => (a.store.memory_deletion_dead_letters ?? []).find((r) => r.memory_id === memoryId);

  it("DELETE purges every correction on the deleted Memory, and none on any other", async () => {
    app = await start();
    seedCorrections(app);
    assert.equal((await call(app, "DELETE", `/api/memories/${PLAIN_MEMORY}`)).status, 204);
    assert.deepEqual(correctionsOf(app, PLAIN_MEMORY), []);
    assert.deepEqual(correctionsOf(app, LIVE_MEMORY).map((c) => c.id), [correction(LIVE_MEMORY, 3).id]);
    const purge = step(lifecycleReport(app), "RAW_EVIDENCE_PURGED");
    assert.deepEqual([purge.outcome, purge.attempts, purge.facts.correctionsPurged], ["done", 1, 2], JSON.stringify(purge));
  });

  it("a FAILED corrections purge fails step 4, is retried to the cap and dead-lettered by name — and the evidence purge still ran", async () => {
    app = await start({ failWrites: new Set(["memory_corrections:delete"]) });
    const { memoryId, episodeId } = await keepEvening(app);
    app.store.memory_corrections = [correction(memoryId, 4)];
    assert.equal((await call(app, "DELETE", `/api/memories/${memoryId}`)).status, 204);
    const report = lifecycleReport(app);
    const purge = step(report, "RAW_EVIDENCE_PURGED");
    assert.deepEqual([purge.outcome, purge.attempts, purge.retryable, purge.facts.correctionsFailed], ["failed", 3, true, true]);
    assert.match(purge.detail, /memory_corrections purge/);
    assert.equal(report.deadLettered, true);
    assert.equal(correctionsOf(app, memoryId).length, 1, "the fake refused the delete, so the row is still there — and the report says so");
    assert.deepEqual(evidenceOf(app, episodeId), [], "both purges are attempted every time: a corrections failure never strands the evidence");
    const l = letterOf(app, memoryId);
    assert.deepEqual(l.failed_steps, ["RAW_EVIDENCE_PURGED"]);
    assert.match(l.detail, /RAW_EVIDENCE_PURGED ×3: memory_corrections purge/);
  });

  it("a delete that answers but leaves a correction readable is a FAILURE, not `done` (the purge is confirmed by a read)", async () => {
    app = await start();
    seedCorrections(app);
    const base = makeClient(app.store);
    const swallowing = { ...base, from: (t: string) => { const c = base.from(t); if (t === "memory_corrections") c.delete = () => c; return c; } };
    _setTestClient(swallowing as any, true);
    assert.equal((await call(app, "DELETE", `/api/memories/${PLAIN_MEMORY}`)).status, 204);
    const purge = step(lifecycleReport(app), "RAW_EVIDENCE_PURGED");
    assert.equal(purge.outcome, "failed", JSON.stringify(purge));
    assert.match(purge.detail, /memory_corrections purge unconfirmed/);
  });

  it("2320 absent, 3673 deployed: step 4 is `done`, purges the corrections and names the store that is not deployed", async () => {
    app = await start({ absent: new Set(["memory_evidence", "memory_episodes"]) });
    seedCorrections(app);
    assert.equal((await call(app, "DELETE", `/api/memories/${PLAIN_MEMORY}`)).status, 204);
    const purge = step(lifecycleReport(app), "RAW_EVIDENCE_PURGED");
    assert.deepEqual([purge.outcome, purge.facts.correctionsPurged, purge.facts.notDeployed], ["done", 2, ["memory_evidence"]]);
    assert.deepEqual(correctionsOf(app, PLAIN_MEMORY), []);
  });

  it("3673 absent: the evidence half runs as before and the report names memory_corrections as not deployed", async () => {
    app = await start({ absent: new Set(["memory_corrections"]) });
    const { memoryId } = await keepEvening(app);
    assert.equal((await call(app, "DELETE", `/api/memories/${memoryId}`)).status, 204);
    const purge = step(lifecycleReport(app), "RAW_EVIDENCE_PURGED");
    assert.deepEqual([purge.outcome, purge.facts.episodesRetired, purge.facts.notDeployed], ["done", 1, ["memory_corrections"]]);
    assert.ok(purge.facts.purged > 0);
  });

  it("the redrive finishes it: a letter left by a failed corrections purge is resolved once the purge succeeds", async () => {
    app = await start({ failWrites: new Set(["memory_corrections:delete"]) });
    seedCorrections(app);
    assert.equal((await call(app, "DELETE", `/api/memories/${PLAIN_MEMORY}`)).status, 204);
    assert.equal(letterOf(app, PLAIN_MEMORY).resolved_at, null);
    app.store.feature_flags.push(FLAG_ON);
    const out = await runMemoryDeletionRedrivePass({ client: makeClient(app.store), now: new Date("2026-10-07T13:00:00.000Z") });
    assert.equal(out.resolved, 1, JSON.stringify(out));
    assert.deepEqual(correctionsOf(app, PLAIN_MEMORY), []);
    assert.notEqual(letterOf(app, PLAIN_MEMORY).resolved_at, null);
    assert.equal(correctionsOf(app, LIVE_MEMORY).length, 1);
  });
});

// ── VERIFY-H6 H6-3 (c1f8daa5a2): "both purges are attempted every time" in the ──
// OTHER direction — an evidence purge that fails never strands the corrections.
describe("VERIFY-H6 H6-3 — an evidence purge that FAILS still purges the deleted Memory's corrections", () => {
  const correction = (memoryId: string) => ({
    id: "c9000000-0000-4000-8000-000000000000", memory_id: memoryId, owner_id: OWNER, field: "place", kind: "reject",
    place_id: "place-9", canonical_location_id: null, source: "correction_route", created_at: "2026-10-07T00:00:09.000Z",
  });
  const correctionsOf = (a: App, memoryId: string) => (a.store.memory_corrections ?? []).filter((c) => c.memory_id === memoryId);

  for (const [how, opts, detail] of [
    ["the evidence DELETE fails", { failWrites: new Set(["memory_evidence:delete"]) }, /memory_evidence/],
    ["the evidence link READ fails", { failReads: new Set(["memory_evidence"]) }, /memory_evidence link read/],
  ] as const) {
    it(`${how}: step 4 fails and is dead-lettered for the evidence — and the corrections are gone`, async () => {
      app = await start();
      const { memoryId, episodeId } = await keepEvening(app);
      app.store.memory_corrections = [correction(memoryId)];
      _setTestClient(makeClient(app.store, opts as FakeOpts) as any, true);
      assert.equal((await call(app, "DELETE", `/api/memories/${memoryId}`)).status, 204);
      const report = lifecycleReport(app);
      const purge = step(report, "RAW_EVIDENCE_PURGED");
      assert.deepEqual([purge.outcome, purge.retryable, purge.attempts, purge.facts.correctionsFailed], ["failed", true, 3, false], JSON.stringify(purge));
      assert.match(purge.detail, detail);
      assert.doesNotMatch(purge.detail, /memory_corrections/, "the corrections half did not fail");
      assert.equal(report.deadLettered, true);
      assert.deepEqual(correctionsOf(app, memoryId), [], "both purges are attempted every time: an evidence failure never strands the corrections");
      assert.equal(evidenceOf(app, episodeId).length, 4, "control: the evidence really was not purged");
    });
  }
});

describe("bounded evidence-link draining never completes on a partial read", () => {
  const now = new Date("2026-10-16T12:00:00.000Z");
  const episodeId = (index: number) => `e8888888-0000-4000-8000-${String(index).padStart(12, "0")}`;
  const addEpisode = (store: Record<string, any[]>, memoryId: string, index: number) => {
    const id = episodeId(index);
    store.memory_episodes.push({ ...store.memory_episodes[0], id, user_id: OWNER, state: "confirmed", detection_digest: id });
    store.memory_evidence.push(
      { id: `link-${index}`, episode_id: id, user_id: OWNER, source_table: "memories", source_id: memoryId, truth_level: "asserted" },
      { id: `capture-${index}`, episode_id: id, user_id: OWNER, source_table: "media_assets", source_id: m(index), truth_level: "observed" },
    );
    return id;
  };
  const fixture = (count = 2) => {
    const store = seed();
    store.memories[0].state = "deleted";
    for (let index = 1; index <= count; index++) addEpisode(store, PLAIN_MEMORY, index);
    return store;
  };
  const erase = (store: Record<string, any[]>, options: FakeOpts = {}) => eraseEvidenceForMemory(makeClient(store, options) as any, {
    memoryId: PLAIN_MEMORY, ownerId: OWNER, now,
  });
  const lifecycle = (store: Record<string, any[]>, options: FakeOpts = {}) => runMemoryDeletionLifecycle(makeClient(store, options) as any, {
    memoryId: PLAIN_MEMORY, ownerId: OWNER, actorUserId: OWNER, previous: { visibility: "only_me", state: "published" }, now,
  });
  const capped = (rows: any[]) => ({ data: rows.slice(0, 1), error: null });
  const pausePoint = () => {
    let arrive!: () => void;
    let release!: () => void;
    const reached = new Promise<void>((resolve) => { arrive = resolve; });
    const resumed = new Promise<void>((resolve) => { release = resolve; });
    return { reached, release, wait: async () => { arrive(); await resumed; } };
  };

  it("the DELETE route purges BOTH linked episodes under a one-row server cap, not just the first", async () => {
    app = await start();
    const kept = await keepEvening(app);
    const secondId = addEpisode(app.store, kept.memoryId, 1);
    const untouched = evidenceOf(app, afternoon(app).id).map((row) => ({ ...row }));
    let reads = 0;
    _setTestClient(makeClient(app.store, { evidenceLinkRead: (rows) => { reads++; return capped(rows); } }) as any, true);
    assert.equal((await call(app, "DELETE", `/api/memories/${kept.memoryId}`)).status, 204);
    assert.deepEqual(evidenceOf(app, secondId), [], "the capped-out episode's evidence must not survive a completed deletion");
    assert.deepEqual(evidenceOf(app, kept.episodeId), []);
    assert.equal(app.store.memory_episodes.find((row) => row.id === secondId).state, "deleted");
    assert.deepEqual(evidenceOf(app, afternoon(app).id), untouched);
    assert.equal(reads, 3, "two short batches and an empty confirmation");
    const report = lifecycleReport(app);
    assert.equal(report.completed, true);
    assert.deepEqual([step(report, "RAW_EVIDENCE_PURGED").facts.purged, step(report, "RAW_EVIDENCE_PURGED").facts.episodesRetired], [6, 2]);
  });

  it("every batch remains scoped to this owner and Memory", async () => {
    const store = fixture();
    const unrelated = addEpisode(store, "another-memory", 3);
    store.memory_evidence.push({ id: "foreign-link", episode_id: FOREIGN_EPISODE, user_id: OTHER, source_table: "memories", source_id: PLAIN_MEMORY });
    const untouched = store.memory_evidence.filter((row) => row.user_id === OTHER || row.episode_id === unrelated);
    const result = await erase(store, { evidenceLinkRead: capped });
    assert.deepEqual(result, { state: "done", episodes: [episodeId(1), episodeId(2)], retired: 2, purged: 4 });
    assert.deepEqual(store.memory_evidence, untouched);
    assert.equal(store.memory_episodes.find((row) => row.id === FOREIGN_EPISODE).state, "confirmed");
    assert.equal(store.memory_episodes.find((row) => row.id === unrelated).state, "confirmed");
  });

  for (const [label, data] of [
    ["null", null], ["object", {}], ["null row", [null]], ["missing episode", [{}]],
    ["numeric episode", [{ episode_id: 7 }]], ["empty episode", [{ episode_id: "" }]],
    ["malformed episode", [{ episode_id: "not-a-uuid" }]],
    ["valid prefix then malformed row", [{ episode_id: episodeId(1) }, {}]],
  ] as const) {
    it(`${label} is a failed read, never empty completion or a destructive partial batch`, async () => {
      const store = fixture();
      const before = structuredClone(store);
      const result = await erase(store, { evidenceLinkRead: () => ({ data, error: null }) });
      assert.equal(result.state, "failed");
      assert.deepEqual(store, before);
    });
  }

  it("a later read failure dead-letters instead of completing, and a retry drains the surviving links", async () => {
    const store = fixture();
    let reads = 0;
    const result = await lifecycle(store, { evidenceLinkRead: (rows) => {
      reads++;
      return reads === 1 ? capped(rows) : { data: null, error: { code: "57014", message: "statement timeout" } };
    } });
    assert.equal(result.completed, false);
    assert.equal(result.deadLetterDurable, true);
    assert.deepEqual([step(result, "RAW_EVIDENCE_PURGED").outcome, step(result, "RAW_EVIDENCE_PURGED").attempts], ["failed", 3]);
    assert.equal(store.memory_evidence.filter((row) => row.episode_id === episodeId(1)).length, 0);
    assert.equal(store.memory_evidence.filter((row) => row.episode_id === episodeId(2)).length, 2);
    assert.equal(store.memory_deletion_dead_letters[0].resolved_at, null);
    const retried = await lifecycle(store, { evidenceLinkRead: capped });
    assert.equal(retried.completed, true);
    assert.deepEqual(store.memory_evidence, []);
    assert.equal(store.memory_deletion_dead_letters[0].resolved_at, now.toISOString());
  });

  it("a malformed terminal response cannot confirm a purge", async () => {
    const store = fixture(1);
    let reads = 0;
    const result = await lifecycle(store, { evidenceLinkRead: (rows) => {
      reads++;
      return reads === 1 ? capped(rows) : { data: null, error: null };
    } });
    assert.equal(result.completed, false);
    assert.equal(result.deadLetterDurable, true);
    assert.deepEqual(store.memory_evidence, []);
    assert.equal(store.memory_deletion_dead_letters[0].resolved_at, null);
    assert.equal((await lifecycle(store)).completed, true);
  });

  for (const code of ["42P01", "PGRST205"]) {
    it(`${code} after a successful batch is failure, not an absent-store success`, async () => {
      const store = fixture();
      let reads = 0;
      const result = await erase(store, { evidenceLinkRead: (rows) => {
        reads++;
        return reads === 1 ? capped(rows) : { data: null, error: { code, message: "missing relation" } };
      } });
      assert.equal(result.state, "failed");
      assert.equal(store.memory_evidence.length, 2);
    });

    it(`${code} after partial cleanup cannot become absent on a lifecycle retry`, async () => {
      const store = fixture();
      let reads = 0;
      const report = await lifecycle(store, { evidenceLinkRead: (rows) => {
        reads++;
        return reads === 1 ? capped(rows) : { data: null, error: { code, message: "missing relation after a successful batch" } };
      } });
      assert.equal(report.completed, false);
      assert.equal(report.deadLettered, true);
      assert.equal(report.deadLetterDurable, true);
      assert.deepEqual([step(report, "RAW_EVIDENCE_PURGED").outcome, step(report, "RAW_EVIDENCE_PURGED").attempts], ["failed", 3]);
      assert.equal(store.memory_episodes.find((row) => row.id === episodeId(1)).state, "deleted");
      assert.equal(store.memory_episodes.find((row) => row.id === episodeId(2)).state, "confirmed");
      assert.deepEqual(store.memory_evidence.map((row) => row.episode_id), [episodeId(2), episodeId(2)]);
      assert.ok(store.memory_deletion_dead_letters[0].failed_steps.includes("RAW_EVIDENCE_PURGED"));
      assert.equal(store.memory_deletion_dead_letters[0].resolved_at, null);
    });

    it(`${code} redrive retains a durable partial-cleanup failure until an empty read confirms completion`, async () => {
      const store = fixture();
      store.feature_flags.push({ flag: "memory_deletion_redrive_enabled", enabled: true });
      let reads = 0;
      const report = await lifecycle(store, { evidenceLinkRead: (rows) => {
        reads++;
        return reads === 1 ? capped(rows) : { data: null, error: { code: "57014", message: "statement timeout after a successful batch" } };
      } });
      assert.equal(report.completed, false);
      assert.equal(report.deadLetterDurable, true);
      assert.ok(store.memory_deletion_dead_letters[0].failed_steps.includes("RAW_EVIDENCE_PURGED"));
      assert.deepEqual(store.memory_evidence.map((row) => row.episode_id), [episodeId(2), episodeId(2)]);

      const durableStore = JSON.parse(JSON.stringify(store)) as Record<string, any[]>;
      const remaining = structuredClone(durableStore.memory_evidence);
      const retried = await runMemoryDeletionRedrivePass({
        client: makeClient(durableStore, { evidenceLinkRead: () => ({ data: null, error: { code, message: "missing relation on a fresh client" } }) }),
        now: new Date(now.getTime() + 1000),
      });
      assert.deepEqual([retried.considered, retried.stillFailing, retried.resolved], [1, 1, 0]);
      assert.equal(durableStore.memory_deletion_dead_letters[0].resolved_at, null);
      assert.deepEqual(durableStore.memory_evidence, remaining);

      let confirmationReads = 0;
      const recoveredAt = new Date(now.getTime() + 2000);
      const recovered = await runMemoryDeletionRedrivePass({
        client: makeClient(durableStore, { evidenceLinkRead: (rows) => { confirmationReads++; return capped(rows); } }),
        now: recoveredAt,
      });
      assert.deepEqual([recovered.considered, recovered.stillFailing, recovered.resolved], [1, 0, 1]);
      assert.equal(confirmationReads, 2);
      assert.deepEqual(durableStore.memory_evidence, []);
      assert.equal(durableStore.memory_episodes.find((row) => row.id === episodeId(2)).state, "deleted");
      assert.equal(durableStore.memory_deletion_dead_letters[0].resolved_at, recoveredAt.toISOString());
    });

    it(`${code} initially absent evidence remains a completed lifecycle control`, async () => {
      const store = fixture(0);
      let reads = 0;
      const report = await lifecycle(store, { evidenceLinkRead: () => {
        reads++;
        return { data: null, error: { code, message: "evidence store not deployed" } };
      } });
      assert.equal(report.completed, true);
      assert.equal(report.deadLettered, false);
      assert.equal(reads, 1);
      assert.deepEqual([step(report, "RAW_EVIDENCE_PURGED").outcome, step(report, "RAW_EVIDENCE_PURGED").attempts], ["done", 1]);
      assert.deepEqual(step(report, "RAW_EVIDENCE_PURGED").facts.notDeployed, ["memory_evidence"]);
      assert.equal((store.memory_deletion_dead_letters ?? []).length, 0);
    });

    it(`${code} initially missing metadata and evidence cannot prove cleanup completed`, async () => {
      const store = fixture(0);
      const report = await lifecycle(store, {
        absent: new Set(["memory_deletion_dead_letters", "memory_evidence"]),
        absentCode: code as "42P01" | "PGRST205",
      });
      assert.equal(report.completed, false);
      assert.equal(report.deadLettered, true);
      assert.equal(report.deadLetterDurable, false);
      assert.equal(report.reachedState, "DERIVATIVES_PURGED");
      const rawEvidence = step(report, "RAW_EVIDENCE_PURGED");
      assert.deepEqual([rawEvidence.outcome, rawEvidence.attempts, rawEvidence.retryable], ["failed", 3, true]);
      assert.equal(rawEvidence.facts.evidenceStoreRequired, true);
      assert.match(rawEvidence.detail, /episode checkpoint read:.*memory_deletion_dead_letters/);
      assert.match(report.deadLetterDetail, /memory_deletion_dead_letters is not deployed/);
      assert.deepEqual(store.memory_evidence, []);
      assert.equal((store.memory_deletion_dead_letters ?? []).length, 0);
    });

    it(`${code} a direct second lifecycle preserves the durable required-evidence marker`, async () => {
      const store = fixture();
      let reads = 0;
      const first = await lifecycle(store, { evidenceLinkRead: (rows) => {
        reads++;
        return reads === 1 ? capped(rows) : { data: null, error: { code: "57014", message: "statement timeout" } };
      } });
      assert.equal(first.deadLetterDurable, true);
      assert.match(store.memory_deletion_dead_letters[0].detail, /^\[memory-evidence:v1:required\] /);
      const durableStore = JSON.parse(JSON.stringify(store)) as Record<string, any[]>;
      const remaining = structuredClone(durableStore.memory_evidence);
      const priorLetters = durableStore.memory_deletion_dead_letters[0].letters;
      const second = await lifecycle(durableStore, { evidenceLinkRead: () => ({ data: null, error: { code, message: "missing relation on retry" } }) });
      assert.equal(second.completed, false);
      assert.equal(second.deadLetterDurable, true);
      assert.equal(step(second, "RAW_EVIDENCE_PURGED").facts.evidenceStoreRequired, true);
      assert.equal(durableStore.memory_deletion_dead_letters[0].letters, priorLetters + 1);
      assert.equal(durableStore.memory_deletion_dead_letters[0].resolved_at, null);
      assert.deepEqual(durableStore.memory_evidence, remaining);
    });

    it(`${code} an unreadable prior-letter detail cannot erase the scheduler's durable obligation`, async () => {
      const store = fixture(1);
      store.feature_flags.push({ flag: "memory_deletion_redrive_enabled", enabled: true });
      assert.equal((await lifecycle(store, { failReads: new Set(["memory_evidence"]) })).deadLetterDurable, true);
      const durableStore = JSON.parse(JSON.stringify(store)) as Record<string, any[]>;
      const remaining = structuredClone(durableStore.memory_evidence);
      let detailReads = 0;
      const result = await runMemoryDeletionRedrivePass({ client: makeClient(durableStore, {
        deadLetterDetailRead: () => {
          detailReads++;
          return { data: null, error: { code, message: "metadata temporarily unavailable" } };
        },
        evidenceLinkRead: () => ({ data: null, error: { code, message: "evidence temporarily unavailable" } }),
      }), now });
      assert.equal(detailReads, 1);
      assert.deepEqual([result.considered, result.stillFailing, result.resolved], [1, 1, 0]);
      assert.equal(durableStore.memory_deletion_dead_letters[0].resolved_at, null);
      assert.deepEqual(durableStore.memory_evidence, remaining);
    });

    it(`${code} a thrown evidence attempt remains required on later absent attempts`, async () => {
      const store = fixture(1);
      const remaining = structuredClone(store.memory_evidence);
      let reads = 0;
      const report = await lifecycle(store, { evidenceLinkRead: () => {
        reads++;
        if (reads === 1) throw new Error("connection reset");
        return { data: null, error: { code, message: "missing relation after thrown read" } };
      } });
      assert.equal(report.completed, false);
      assert.equal(report.deadLetterDurable, true);
      assert.equal(reads, 3);
      assert.equal(step(report, "RAW_EVIDENCE_PURGED").facts.evidenceStoreRequired, true);
      assert.match(store.memory_deletion_dead_letters[0].detail, /^\[memory-evidence:v1:required\] /);
      assert.deepEqual(store.memory_evidence, remaining);
    });

    it(`${code} initially absent evidence does not block redrive of a corrections-only failure`, async () => {
      const store = fixture(0);
      store.feature_flags.push({ flag: "memory_deletion_redrive_enabled", enabled: true });
      store.memory_corrections = [{
        id: "c9000000-0000-4000-8000-000000000000", memory_id: PLAIN_MEMORY, owner_id: OWNER,
        field: "place", kind: "reject", place_id: "place-9", canonical_location_id: null,
        source: "correction_route", created_at: now.toISOString(),
      }];
      const evidenceLinkRead = () => ({ data: null, error: { code, message: "evidence store not deployed" } });
      const report = await lifecycle(store, { evidenceLinkRead, failWrites: new Set(["memory_corrections:delete"]) });
      assert.equal(report.completed, false);
      assert.equal(report.deadLetterDurable, true);
      assert.deepEqual(store.memory_deletion_dead_letters[0].failed_steps, ["RAW_EVIDENCE_PURGED"]);
      assert.match(store.memory_deletion_dead_letters[0].detail, /^\[memory-evidence:v1:absent\] /);
      assert.equal(store.memory_corrections.length, 1);

      const durableStore = JSON.parse(JSON.stringify(store)) as Record<string, any[]>;
      const recoveredAt = new Date(now.getTime() + 1000);
      const recovered = await runMemoryDeletionRedrivePass({ client: makeClient(durableStore, { evidenceLinkRead }), now: recoveredAt });
      assert.deepEqual([recovered.considered, recovered.stillFailing, recovered.resolved], [1, 0, 1]);
      assert.deepEqual(durableStore.memory_evidence, []);
      assert.deepEqual(durableStore.memory_corrections, []);
      assert.equal(durableStore.memory_deletion_dead_letters[0].resolved_at, recoveredAt.toISOString());
    });
  }

  for (const code of ["42P01", "PGRST205"]) {
    for (const scenario of [
      { label: "overlapping absent completion cannot resolve a newer required letter", pause: "evidence", correctionsFail: false },
      { label: "overlapping absent failure cannot downgrade a newer required marker", pause: "evidence", correctionsFail: true },
      { label: "overlapping marker write rechecks a required letter changed after its snapshot", pause: "marker", correctionsFail: true },
      { label: "overlapping final resolution rejects a required letter changed after its snapshot", pause: "resolution", correctionsFail: false },
    ]) {
      it(`${code} ${scenario.label}`, { timeout: 5000 }, async () => {
        const store = fixture(0);
        store.memory_corrections = [{
          id: "c9000000-0000-4000-8000-000000000000", memory_id: PLAIN_MEMORY, owner_id: OWNER,
          field: "place", kind: "reject", place_id: "place-9", canonical_location_id: null,
          source: "correction_route", created_at: now.toISOString(),
        }];
        const absentEvidence = () => ({ data: null, error: { code, message: "evidence relation unavailable" } });
        const initial = await lifecycle(store, { evidenceLinkRead: absentEvidence, failWrites: new Set(["memory_corrections:delete"]) });
        assert.equal(initial.deadLetterDurable, true);
        assert.match(store.memory_deletion_dead_letters[0].detail, /^\[memory-evidence:v1:absent\] /);
        addEpisode(store, PLAIN_MEMORY, 1);
        const remaining = structuredClone(store.memory_evidence);
        const paused = pausePoint();
        let pausedOnce = false;
        const older = lifecycle(store, {
          failWrites: scenario.correctionsFail ? new Set(["memory_corrections:delete"]) : undefined,
          evidenceLinkRead: async () => {
            if (scenario.pause === "evidence" && !pausedOnce) {
              pausedOnce = true;
              await paused.wait();
            }
            return absentEvidence();
          },
          beforeDeadLetterWrite: async (_mode, payload) => {
            const absentMarkerWrite = typeof payload?.detail === "string" && payload.detail.startsWith("[memory-evidence:v1:absent] ");
            const resolutionWrite = payload?.resolved_at != null;
            if (!pausedOnce && ((scenario.pause === "marker" && absentMarkerWrite) || (scenario.pause === "resolution" && resolutionWrite))) {
              pausedOnce = true;
              await paused.wait();
            }
          },
        });
        await paused.reached;
        let newerLetter: any;
        const newer = await lifecycle(store, { failWrites: new Set(["memory_evidence:delete", "memory_corrections:delete"]) })
          .then((report) => { newerLetter = structuredClone(store.memory_deletion_dead_letters[0]); return report; })
          .finally(() => paused.release());
        const olderReport = await older;
        assert.equal(newer.completed, false);
        assert.equal(newer.deadLetterDurable, true);
        assert.match(newerLetter.detail, /^\[memory-evidence:v1:required\] /);
        assert.equal(newerLetter.resolved_at, null);
        assert.deepEqual({
          olderCompleted: olderReport.completed,
          requiredMarker: store.memory_deletion_dead_letters[0].detail.startsWith("[memory-evidence:v1:required] "),
          unresolved: store.memory_deletion_dead_letters[0].resolved_at === null,
          remainingEvidence: store.memory_evidence,
        }, { olderCompleted: false, requiredMarker: true, unresolved: true, remainingEvidence: remaining });
      });
    }

    it(`${code} required absent evidence and failed corrections preserve both diagnostics`, async () => {
      const store = fixture(1);
      assert.equal((await lifecycle(store, { failReads: new Set(["memory_evidence"]) })).deadLetterDurable, true);
      store.memory_corrections = [{
        id: "c9000000-0000-4000-8000-000000000000", memory_id: PLAIN_MEMORY, owner_id: OWNER,
        field: "place", kind: "reject", place_id: "place-9", canonical_location_id: null,
        source: "correction_route", created_at: now.toISOString(),
      }];
      const remaining = structuredClone(store.memory_evidence);
      const corrections = structuredClone(store.memory_corrections);
      const report = await lifecycle(store, {
        evidenceLinkRead: () => ({ data: null, error: { code, message: "evidence relation unavailable" } }),
        failWrites: new Set(["memory_corrections:delete"]),
      });
      const rawEvidence = step(report, "RAW_EVIDENCE_PURGED");
      assert.equal(report.completed, false);
      assert.equal(report.deadLetterDurable, true);
      assert.deepEqual([rawEvidence.outcome, rawEvidence.attempts], ["failed", 3]);
      assert.match(rawEvidence.detail, /memory_evidence/);
      assert.match(rawEvidence.detail, /memory_corrections.*failed/);
      assert.equal(rawEvidence.facts.correctionsFailed, true);
      assert.equal(rawEvidence.facts.evidenceStoreRequired, true);
      assert.match(store.memory_deletion_dead_letters[0].detail, /memory_evidence/);
      assert.match(store.memory_deletion_dead_letters[0].detail, /memory_corrections.*failed/);
      assert.equal(store.memory_deletion_dead_letters[0].resolved_at, null);
      assert.deepEqual(store.memory_evidence, remaining);
      assert.deepEqual(store.memory_corrections, corrections);
    });
  }

  it("the dead-letter fake preserves an existing row on an ignored insert conflict", async () => {
    const store = fixture(0);
    assert.equal((await lifecycle(store, { failReads: new Set(["memory_evidence"]) })).deadLetterDurable, true);
    const before = structuredClone(store.memory_deletion_dead_letters);
    const result = await makeClient(store).from("memory_deletion_dead_letters")
      .upsert({ ...before[0], detail: "[memory-evidence:v1:absent] stale insert" }, { onConflict: "memory_id", ignoreDuplicates: true })
      .select("memory_id");
    assert.equal(result.error, null);
    assert.deepEqual(result.data, []);
    assert.deepEqual(store.memory_deletion_dead_letters, before);
  });

  const invalidSnapshots: Array<[string, (row: any) => FakeReadResult]> = [
    ["array response", (row) => ({ data: [row], error: null })],
    ["wrong Memory", (row) => ({ data: { ...row, memory_id: "90000000-0000-4000-8000-000000000002" }, error: null })],
    ["wrong owner", (row) => ({ data: { ...row, owner_id: OTHER }, error: null })],
    ["string letters", (row) => ({ data: { ...row, letters: "1" }, error: null })],
    ["exhausted integer letters", (row) => ({ data: { ...row, letters: 2147483647 }, error: null })],
    ["invalid first failure date", (row) => ({ data: { ...row, first_failed_at: "not-a-date" }, error: null })],
    ["reversed failure dates", (row) => ({ data: { ...row, last_failed_at: "2026-01-01T00:00:00.000Z" }, error: null })],
    ["missing resolution field", (row) => ({ data: { ...row, resolved_at: undefined }, error: null })],
    ["resolved query error", () => ({ data: null, error: { code: "57014", message: "snapshot timeout" } })],
    ["thrown query error", () => { throw new Error("snapshot connection reset"); }],
  ];
  for (const [label, snapshotRead] of invalidSnapshots) {
    it(`full snapshot ${label} blocks completion and recording without mutating the letter`, async () => {
      for (const phase of ["completion", "recording"]) {
        const store = fixture(0);
        assert.equal((await lifecycle(store, { failReads: new Set(["memory_evidence"]) })).deadLetterDurable, true);
        const before = structuredClone(store.memory_deletion_dead_letters);
        let snapshotReads = 0;
        let writes = 0;
        const report = await lifecycle(store, {
          failReads: phase === "recording" ? new Set(["memory_evidence"]) : undefined,
          deadLetterSnapshotRead: (rows) => { snapshotReads++; return snapshotRead(rows[0]); },
          beforeDeadLetterWrite: async () => { writes++; },
        });
        assert.equal(report.completed, false, phase);
        assert.equal(report.deadLetterDurable, false, phase);
        assert.equal(step(report, "RAW_EVIDENCE_PURGED").outcome, "failed", phase);
        assert.equal(snapshotReads, 4, phase);
        assert.equal(writes, 0, phase);
        assert.deepEqual(store.memory_deletion_dead_letters, before, phase);
      }
    });
  }

  for (const phase of ["resolution", "recording"]) {
    it(`an owner change after the ${phase} snapshot rejects the stale write`, async () => {
      const store = fixture(0);
      assert.equal((await lifecycle(store, { failReads: new Set(["memory_evidence"]) })).deadLetterDurable, true);
      const otherClient = makeClient(store);
      let afterOwnerChange: any;
      let writes = 0;
      const report = await lifecycle(store, {
        failReads: phase === "recording" ? new Set(["memory_evidence"]) : undefined,
        beforeDeadLetterWrite: async () => {
          writes++;
          assert.equal(writes, 1);
          const changed = await otherClient.from("memory_deletion_dead_letters").update({ owner_id: OTHER })
            .eq("memory_id", PLAIN_MEMORY).select("memory_id");
          assert.equal(changed.data.length, 1);
          afterOwnerChange = structuredClone(store.memory_deletion_dead_letters);
        },
      });
      assert.equal(writes, 1);
      assert.equal(report.completed, false);
      assert.equal(report.deadLetterDurable, false);
      assert.match(report.deadLetterDetail, /malformed or mismatched/);
      assert.deepEqual(store.memory_deletion_dead_letters, afterOwnerChange);
      assert.equal(store.memory_deletion_dead_letters[0].owner_id, OTHER);
      assert.equal(store.memory_deletion_dead_letters[0].resolved_at, null);
    });
  }

  it("persistent record conflicts stop after three CAS attempts without claiming durability", async () => {
    const store = fixture(0);
    assert.equal((await lifecycle(store, { failReads: new Set(["memory_evidence"]) })).deadLetterDurable, true);
    const otherClient = makeClient(store);
    let writes = 0;
    let competingLetter: any;
    const report = await lifecycle(store, {
      failReads: new Set(["memory_evidence"]),
      beforeDeadLetterWrite: async () => {
        writes++;
        assert.ok(writes <= 3);
        const current = store.memory_deletion_dead_letters[0];
        const changed = await otherClient.from("memory_deletion_dead_letters").update({ letters: current.letters + 1 })
          .eq("memory_id", PLAIN_MEMORY).select("memory_id");
        assert.equal(changed.data.length, 1);
        competingLetter = structuredClone(store.memory_deletion_dead_letters);
      },
    });
    assert.equal(writes, 3);
    assert.equal(report.completed, false);
    assert.equal(report.deadLetterDurable, false);
    assert.match(report.deadLetterDetail, /changed concurrently.*bounded retries/);
    assert.deepEqual(store.memory_deletion_dead_letters, competingLetter);
    assert.equal(store.memory_deletion_dead_letters[0].resolved_at, null);
  });

  it("an absent insert loses a concurrent required insert and retries without downgrading it", { timeout: 5000 }, async () => {
    const store = fixture(1);
    const remaining = structuredClone(store.memory_evidence);
    const paused = pausePoint();
    let inserts = 0;
    const older = lifecycle(store, {
      evidenceLinkRead: () => ({ data: null, error: { code: "42P01", message: "evidence unavailable" } }),
      failWrites: new Set(["memory_corrections:delete"]),
      beforeDeadLetterWrite: async (mode) => {
        if (mode === "upsert") { inserts++; await paused.wait(); }
      },
    });
    await paused.reached;
    const newer = await lifecycle(store, { failWrites: new Set(["memory_evidence:delete", "memory_corrections:delete"]) })
      .finally(() => paused.release());
    const olderReport = await older;
    assert.equal(newer.deadLetterDurable, true);
    assert.equal(olderReport.completed, false);
    assert.equal(olderReport.deadLetterDurable, true);
    assert.equal(inserts, 1);
    assert.equal(store.memory_deletion_dead_letters.length, 1);
    assert.match(store.memory_deletion_dead_letters[0].detail, /^\[memory-evidence:v1:required\] /);
    assert.equal(store.memory_deletion_dead_letters[0].resolved_at, null);
    assert.equal(store.memory_deletion_dead_letters[0].letters, 2);
    assert.deepEqual(store.memory_evidence, remaining);
  });

  for (const code of ["42P01", "PGRST205"]) {
    it(`${code} a stale scheduler moot write cannot resolve a concurrent required deletion`, { timeout: 5000 }, async () => {
      const store = fixture(0);
      const initial = await lifecycle(store, {
        evidenceLinkRead: () => ({ data: null, error: { code, message: "evidence relation unavailable" } }),
        failWrites: new Set(["memory_corrections:delete"]),
      });
      assert.equal(initial.deadLetterDurable, true);
      assert.match(store.memory_deletion_dead_letters[0].detail, /^\[memory-evidence:v1:absent\] /);
      assert.deepEqual(store.memory_deletion_dead_letters[0].failed_steps, ["RAW_EVIDENCE_PURGED"]);
      store.memories[0].state = "published";
      store.feature_flags.push({ flag: "memory_deletion_redrive_enabled", enabled: true });
      addEpisode(store, PLAIN_MEMORY, 1);
      const remaining = structuredClone(store.memory_evidence);
      const paused = pausePoint();
      let mootWrites = 0;
      const schedulerClient = makeClient(store, { beforeDeadLetterWrite: async (_mode, payload) => {
        if (payload?.resolved_at != null && typeof payload?.detail === "string" && payload.detail.includes(" | moot:")) {
          mootWrites++;
          await paused.wait();
        }
      } });
      const scheduled = runMemoryDeletionRedrivePass({ client: schedulerClient, now: new Date(now.getTime() + 1000) });
      await paused.reached;
      const deletionClient = makeClient(store, { failWrites: new Set(["memory_evidence:delete"]) });
      let requiredLetter: any;
      const concurrent = await (async () => {
        const deleted = await deletionClient.from("memories").update({ state: "deleted" })
          .eq("id", PLAIN_MEMORY).eq("owner_id", OWNER).select("id");
        assert.equal(deleted.data.length, 1);
        const report = await runMemoryDeletionLifecycle(deletionClient as any, {
          memoryId: PLAIN_MEMORY, ownerId: OWNER, actorUserId: OWNER,
          previous: { visibility: "only_me", state: "published" }, now: new Date(now.getTime() + 2000),
        });
        requiredLetter = structuredClone(store.memory_deletion_dead_letters[0]);
        return report;
      })().finally(() => paused.release());
      const result = await scheduled;
      assert.equal(concurrent.completed, false);
      assert.equal(concurrent.deadLetterDurable, true);
      assert.match(requiredLetter.detail, /^\[memory-evidence:v1:required\] /);
      assert.equal(requiredLetter.letters, 2);
      assert.equal(requiredLetter.resolved_at, null);
      assert.equal(mootWrites, 1);
      assert.deepEqual({
        considered: result.considered, moot: result.moot, unreadable: result.unreadable,
        stillFailing: result.stillFailing, resolved: result.resolved,
        letter: store.memory_deletion_dead_letters[0], evidence: store.memory_evidence,
      }, {
        considered: 1, moot: 0, unreadable: 1, stillFailing: 0, resolved: 0,
        letter: requiredLetter, evidence: remaining,
      });
    });
  }

  it("an in-run retry completes only after a successful empty confirmation", async () => {
    const store = fixture(1);
    let reads = 0;
    const report = await lifecycle(store, { evidenceLinkRead: (rows) => {
      reads++;
      return reads === 2 ? { data: null, error: { code: "57014", message: "confirmation timeout" } } : capped(rows);
    } });
    assert.equal(report.completed, true);
    assert.equal(reads, 3);
    assert.equal(step(report, "RAW_EVIDENCE_PURGED").attempts, 2);
    assert.equal(step(report, "RAW_EVIDENCE_PURGED").facts.evidenceStoreRequired, true);
    assert.deepEqual(store.memory_evidence, []);
    assert.equal(store.memory_episodes.find((row) => row.id === episodeId(1)).state, "deleted");
    assert.equal(store.memory_deletion_dead_letters.length, 1);
    assert.equal(store.memory_deletion_dead_letters[0].resolved_at, now.toISOString());
  });

  for (const [label, detail] of [
    ["legacy", "RAW_EVIDENCE_PURGED ×3: memory_evidence is not deployed"],
    ["embedded", "prior failure: [memory-evidence:v1:absent] message"],
    ["unknown version", "[memory-evidence:v2:absent] message"],
    ["missing delimiter", "[memory-evidence:v1:absent]message"],
  ]) {
    it(`${label} metadata cannot grant the absent-store exception`, async () => {
      const store = fixture(1);
      const remaining = structuredClone(store.memory_evidence);
      assert.equal((await lifecycle(store, { failReads: new Set(["memory_evidence"]) })).deadLetterDurable, true);
      store.memory_deletion_dead_letters[0].detail = detail;
      const report = await lifecycle(store, { absent: new Set(["memory_evidence"]) });
      assert.equal(report.completed, false);
      if (label === "unknown version" || label === "missing delimiter") {
        assert.equal(report.deadLetterDurable, false);
        assert.equal(store.memory_deletion_dead_letters[0].detail, detail);
      } else {
        assert.equal(report.deadLetterDurable, true);
        assert.match(store.memory_deletion_dead_letters[0].detail, /^\[memory-evidence:v1:required\] /);
      }
      assert.equal(store.memory_deletion_dead_letters[0].resolved_at, null);
      assert.deepEqual(store.memory_evidence, remaining);
    });
  }

  for (const failure of ["resolved error", "throw"]) {
    it(`a prior-letter ${failure} cannot grant the absent-store exception`, async () => {
      const store = fixture(1);
      const remaining = structuredClone(store.memory_evidence);
      assert.equal((await lifecycle(store, { failReads: new Set(["memory_evidence"]) })).deadLetterDurable, true);
      const report = await lifecycle(store, {
        absent: new Set(["memory_evidence"]),
        deadLetterDetailRead: () => {
          if (failure === "throw") throw new Error("metadata connection reset");
          return { data: null, error: { code: "57014", message: "metadata timeout" } };
        },
      });
      assert.equal(report.completed, false);
      assert.equal(report.deadLetterDurable, true);
      assert.equal(store.memory_deletion_dead_letters[0].resolved_at, null);
      assert.deepEqual(store.memory_evidence, remaining);
    });
  }

  it("a purge that leaves its link readable fails without looping indefinitely", async () => {
    const store = fixture(1);
    let reads = 0;
    const result = await erase(store, { retainEvidenceOnDelete: true, evidenceLinkRead: (rows) => { reads++; return capped(rows); } });
    assert.equal(result.state, "failed");
    assert.equal(reads, 1);
    if (result.state === "failed") assert.match(result.detail, /purge confirmation/);
    assert.equal(store.memory_evidence.length, 2);
  });

  it("the batch budget leaves a retryable remainder instead of claiming complete erasure", async () => {
    const store = fixture(101);
    let reads = 0;
    const result = await erase(store, { evidenceLinkRead: (rows) => { reads++; return capped(rows); } });
    assert.equal(result.state, "failed");
    assert.equal(reads, 101);
    assert.equal(store.memory_evidence.length, 2);
    assert.equal((await erase(store, { evidenceLinkRead: capped })).state, "done");
    assert.deepEqual(store.memory_evidence, []);
  });

  it("an empty array is a complete no-evidence control", async () => {
    assert.deepEqual(await erase(fixture(0)), { state: "done", episodes: [], retired: 0, purged: 0 });
  });

  it("a first-read missing table retains the absent-store contract", async () => {
    const result = await erase(fixture(), { absent: new Set(["memory_evidence"]) });
    assert.equal(result.state, "absent");
  });
});

describe("evidence erasure confirms mutation postconditions", () => {
  const now = new Date("2026-10-16T18:00:00.000Z");
  const episodeId = (index: number) => `e7777777-0000-4000-8000-${String(index).padStart(12, "0")}`;
  const fixture = (linked: boolean, count = 1) => {
    const store = seed();
    store.memories[0].state = "deleted";
    for (let index = 1; index <= count; index++) {
      const id = episodeId(index);
      store.memory_episodes.push({ ...store.memory_episodes[0], id, user_id: OWNER, summary: "private episode", place_id: "private-place", state: "confirmed" });
      if (linked) store.memory_evidence.push({ id: `retry-link-${index}`, episode_id: id, user_id: OWNER, source_table: "memories", source_id: PLAIN_MEMORY });
      store.memory_evidence.push(
        { id: `capture-a-${index}`, episode_id: id, user_id: OWNER, source_table: "media_assets", source_id: m(index) },
        { id: `capture-b-${index}`, episode_id: id, user_id: OWNER, source_table: "media_assets", source_id: m(index + 10) },
      );
    }
    return store;
  };
  const erase = (store: Record<string, any[]>, order: "retire_first" | "purge_first", options: FakeOpts = {}, episodeIds = [episodeId(1)]) =>
    retireEpisodesAndPurgeEvidence(makeClient(store, options) as any, { ownerId: OWNER, episodeIds, now, order });
  const assertRetired = (store: Record<string, any[]>, id = episodeId(1)) => {
    const episode = store.memory_episodes.find((row) => row.id === id);
    assert.equal(episode.state, "deleted");
    for (const field of Object.keys(RETIRED_EPISODE_CLEARED)) assert.equal(episode[field], null, field);
  };

  for (const order of ["retire_first", "purge_first"] as const) {
    for (const [label, data] of [["null", null], ["object", {}], ["missing id", [{}]]] as const) {
      it(`${order}: ${label} retirement response cannot authorize cleanup completion`, async () => {
        const store = fixture(order === "retire_first");
        const before = structuredClone(store.memory_evidence);
        const result = await erase(store, order, { retireMutation: () => ({ data, error: null }) });
        assert.equal(result.state, "failed");
        assert.equal(store.memory_episodes.find((row) => row.id === episodeId(1)).state, "confirmed");
        if (order === "retire_first") assert.deepEqual(store.memory_evidence, before);
        assert.equal((await erase(store, order)).state, "done");
        assertRetired(store);
        assert.deepEqual(store.memory_evidence, []);
      });

      it(`${order}: ${label} purge response cannot authorize cleanup completion`, async () => {
        const store = fixture(order === "retire_first");
        const before = structuredClone(store.memory_evidence);
        const result = await erase(store, order, { purgeMutation: () => ({ data, error: null }) });
        assert.equal(result.state, "failed");
        assert.deepEqual(store.memory_evidence, before);
        if (order === "purge_first") assert.equal(store.memory_episodes.find((row) => row.id === episodeId(1)).state, "confirmed");
        assert.equal((await erase(store, order)).state, "done");
        assertRetired(store);
        assert.deepEqual(store.memory_evidence, []);
      });
    }

    it(`${order}: a partial retirement cannot hide an untouched episode`, async () => {
      const store = fixture(order === "retire_first", 2);
      const before = structuredClone(store.memory_evidence);
      const result = await erase(store, order, { retireMutation: (rows, payload) => {
        Object.assign(rows[0], payload);
        return { data: [{ id: rows[0].id }], error: null };
      } }, [episodeId(1), episodeId(2)]);
      assert.equal(result.state, "failed");
      assert.equal(store.memory_episodes.find((row) => row.id === episodeId(2)).state, "confirmed");
      if (order === "retire_first") assert.deepEqual(store.memory_evidence, before);
      assert.equal((await erase(store, order, {}, [episodeId(1), episodeId(2)])).state, "done");
      assertRetired(store, episodeId(1));
      assertRetired(store, episodeId(2));
      assert.deepEqual(store.memory_evidence, []);
    });

    for (const field of Object.keys(RETIRED_EPISODE_CLEARED)) {
      it(`${order}: an uncleared ${field} prevents a retirement claim`, async () => {
        const store = fixture(order === "retire_first");
        const episode = store.memory_episodes.find((row) => row.id === episodeId(1));
        if (field === "merged_into_id") { episode.state = "merged"; episode.merged_into_id = FOREIGN_EPISODE; }
        const before = structuredClone(store.memory_evidence);
        const result = await erase(store, order, { retireMutation: (rows, payload) => {
          for (const row of rows) { const retained = row[field]; Object.assign(row, payload); row[field] = retained; }
          return { data: rows.map((row) => ({ id: row.id })), error: null };
        } });
        assert.equal(result.state, "failed");
        assert.notEqual(episode[field], null);
        if (order === "retire_first") assert.deepEqual(store.memory_evidence, before);
      });
    }

    it(`${order}: a partial purge is a failure and a retry finishes it`, async () => {
      const store = fixture(order === "retire_first");
      const result = await erase(store, order, { purgeMutation: (rows) => {
        const removed = rows.slice(0, 1);
        store.memory_evidence = store.memory_evidence.filter((row) => !removed.includes(row));
        return { data: removed.map((row) => ({ id: row.id })), error: null };
      } });
      assert.equal(result.state, "failed");
      assert.ok(store.memory_evidence.length > 0);
      if (order === "purge_first") assert.equal(store.memory_episodes.find((row) => row.id === episodeId(1)).state, "confirmed");
      assert.equal((await erase(store, order)).state, "done");
      assertRetired(store);
      assert.deepEqual(store.memory_evidence, []);
    });

    it(`${order}: already absent episodes and evidence are an idempotent success`, async () => {
      const store = fixture(false, 0);
      assert.deepEqual(await erase(store, order), { state: "done", episodes: [episodeId(1)], retired: 0, purged: 0 });
      assert.deepEqual(store.memory_evidence, []);
    });

    it(`${order}: another owner's episode and evidence are never changed`, async () => {
      const store = fixture(false, 0);
      store.memory_evidence.push({ id: "foreign-capture", episode_id: FOREIGN_EPISODE, user_id: OTHER, source_table: "media_assets", source_id: m(99) });
      const before = structuredClone(store);
      assert.deepEqual(await erase(store, order, {}, [FOREIGN_EPISODE]), { state: "done", episodes: [FOREIGN_EPISODE], retired: 0, purged: 0 });
      assert.deepEqual(store, before);
    });
  }

  it("purge_first preserves an existing Memory link until retirement is confirmed", async () => {
    const store = fixture(true);
    const before = structuredClone(store.memory_evidence);
    const result = await erase(store, "purge_first", { retireMutation: () => ({ data: [], error: null }) });
    assert.equal(result.state, "failed");
    assert.deepEqual(store.memory_evidence, before);
    assert.equal(store.memory_episodes.find((row) => row.id === episodeId(1)).state, "confirmed");
    assert.equal((await erase(store, "purge_first")).state, "done");
    assertRetired(store);
    assert.deepEqual(store.memory_evidence, []);
  });

  it("a partial lifecycle purge retains its retry link instead of orphaning captures", async () => {
    const store = fixture(true);
    const options = { memoryId: PLAIN_MEMORY, ownerId: OWNER, actorUserId: OWNER, previous: { visibility: "only_me" as const, state: "published" as const }, now };
    const report = await runMemoryDeletionLifecycle(makeClient(store, { purgeMutation: (rows) => {
      const removed = rows.filter((row) => row.source_table === "memories");
      store.memory_evidence = store.memory_evidence.filter((row) => !removed.includes(row));
      return { data: removed.map((row) => ({ id: row.id })), error: null };
    } }) as any, options);
    assert.equal(report.completed, false);
    assert.equal(report.deadLetterDurable, true);
    assert.equal(store.memory_evidence.filter((row) => row.source_table === "memories").length, 1);
    assert.equal(store.memory_evidence.filter((row) => row.source_table === "media_assets").length, 2);
    const retried = await runMemoryDeletionLifecycle(makeClient(store) as any, options);
    assert.equal(retried.completed, true);
    assertRetired(store);
    assert.deepEqual(store.memory_evidence, []);
    assert.equal(store.memory_deletion_dead_letters[0].resolved_at, now.toISOString());
  });

  for (const order of ["retire_first", "purge_first"] as const) {
    for (const confirmation of ["episode", "evidence"] as const) {
      for (const failure of ["malformed", "error", "throw", "42P01", "PGRST205"]) {
        it(`${order}: ${confirmation} confirmation ${failure} cannot authorize completion`, async () => {
          const store = fixture(order === "retire_first");
          let probes = 0;
          const result = await erase(store, order, { memoryRead: (table, selected) => {
            const target = confirmation === "episode"
              ? table === "memory_episodes" && selected?.includes("merged_into_id")
              : table === "memory_evidence" && selected === "id";
            if (!target) return;
            probes++;
            if (failure === "throw") throw new Error("confirmation connection reset");
            return failure === "malformed" ? { data: {}, error: null }
              : { data: null, error: { code: failure === "error" ? "57014" : failure, message: "confirmation unavailable" } };
          } });
          assert.equal(result.state, "failed");
          assert.equal(probes, 1);
          if (order === "retire_first") assert.equal(store.memory_evidence.filter((row) => row.source_table === "memories").length, 1);
          assert.equal((await erase(store, order)).state, "done");
          assertRetired(store);
          assert.deepEqual(store.memory_evidence, []);
        });
      }
    }

    it(`${order}: a null evidence confirmation is not an empty array`, async () => {
      const store = fixture(order === "retire_first");
      const result = await erase(store, order, { memoryRead: (table, selected) => {
        if (table === "memory_evidence" && selected === "id") return { data: null, error: null };
        return undefined;
      } });
      assert.equal(result.state, "failed");
      if (order === "retire_first") assert.equal(store.memory_evidence.filter((row) => row.source_table === "memories").length, 1);
      else assert.equal(store.memory_episodes.find((row) => row.id === episodeId(1)).state, "confirmed");
    });

    it(`${order}: capped mutation replies succeed only with complete postconditions`, async () => {
      const store = fixture(order === "retire_first", 2);
      const result = await erase(store, order, {
        retireMutation: (rows, payload) => {
          for (const row of rows) Object.assign(row, payload);
          return { data: rows.slice(0, 1).map((row) => ({ id: row.id })), error: null };
        },
        purgeMutation: (rows) => {
          store.memory_evidence = store.memory_evidence.filter((row) => !rows.includes(row));
          return { data: rows.slice(0, 1).map((row) => ({ id: row.id })), error: null };
        },
      }, [episodeId(1), episodeId(2)]);
      assert.equal(result.state, "done");
      assertRetired(store, episodeId(1));
      assertRetired(store, episodeId(2));
      assert.deepEqual(store.memory_evidence, []);
    });

    it(`${order}: empty mutation replies cannot hide existing unretired episodes`, async () => {
      const store = fixture(order === "retire_first");
      const result = await erase(store, order, { retireMutation: () => ({ data: [], error: null }) });
      assert.equal(result.state, "failed");
      assert.equal(store.memory_episodes.find((row) => row.id === episodeId(1)).state, "confirmed");
    });

    it(`${order}: empty purge replies cannot hide surviving captures`, async () => {
      const store = fixture(order === "retire_first");
      const before = structuredClone(store.memory_evidence);
      const result = await erase(store, order, { purgeMutation: () => ({ data: [], error: null }) });
      assert.equal(result.state, "failed");
      assert.deepEqual(store.memory_evidence, before);
    });

    it(`${order}: foreign evidence on the same episode and unrelated owned evidence stay untouched`, async () => {
      const store = fixture(order === "retire_first", 2);
      store.memory_evidence.push({ id: "foreign-capture", episode_id: episodeId(1), user_id: OTHER, source_table: "media_assets", source_id: m(99) });
      const untouched = structuredClone(store.memory_evidence.filter((row) => row.episode_id === episodeId(2) || row.user_id === OTHER));
      assert.equal((await erase(store, order)).state, "done");
      assertRetired(store);
      assert.deepEqual(store.memory_evidence, untouched);
      assert.equal(store.memory_episodes.find((row) => row.id === episodeId(2)).state, "confirmed");
    });
  }

  for (const malformed of ["array", "undefined", "wrong id", "foreign owner", "missing scrub field"]) {
    it(`a ${malformed} retirement confirmation preserves the retry link`, async () => {
      const store = fixture(true);
      const before = structuredClone(store.memory_evidence);
      const result = await erase(store, "retire_first", { memoryRead: (table, selected, rows) => {
        if (table !== "memory_episodes" || !selected?.includes("merged_into_id")) return;
        if (malformed === "array") return { data: [], error: null };
        if (malformed === "undefined") return { data: undefined, error: null };
        const row = { ...rows[0] };
        if (malformed === "wrong id") row.id = FOREIGN_EPISODE;
        if (malformed === "foreign owner") row.user_id = OTHER;
        if (malformed === "missing scrub field") delete row.summary;
        return { data: row, error: null };
      } });
      assert.equal(result.state, "failed");
      assert.deepEqual(store.memory_evidence, before);
    });
  }

  for (const response of [null, [], [{}]]) {
    it(`a malformed or ineffective final link deletion (${JSON.stringify(response)}) remains retryable`, async () => {
      const store = fixture(true);
      const result = await erase(store, "retire_first", { purgeMutation: (rows) => {
        if (rows.some((row) => row.source_table === "memories")) return { data: response, error: null };
        store.memory_evidence = store.memory_evidence.filter((row) => !rows.includes(row));
        return { data: rows.map((row) => ({ id: row.id })), error: null };
      } });
      assert.equal(result.state, "failed");
      assert.equal(store.memory_evidence.length, 1);
      assert.equal(store.memory_evidence[0].source_table, "memories");
      assert.equal((await erase(store, "retire_first")).state, "done");
      assert.deepEqual(store.memory_evidence, []);
    });
  }

  it("the retry sentinel belongs to the erased Memory, not an earlier collateral link", async () => {
    const store = fixture(true);
    store.memory_evidence.push({ id: "a-collateral-link", episode_id: episodeId(1), user_id: OWNER, source_table: "memories", source_id: "another-memory" });
    const result = await eraseEvidenceForMemory(makeClient(store, { purgeMutation: (rows) => {
      const removed = rows.filter((row) => row.source_table === "memories");
      store.memory_evidence = store.memory_evidence.filter((row) => !removed.includes(row));
      return { data: removed.map((row) => ({ id: row.id })), error: null };
    } }) as any, { ownerId: OWNER, memoryId: PLAIN_MEMORY, now });
    assert.equal(result.state, "failed");
    assert.equal(store.memory_evidence.filter((row) => row.source_table === "memories" && row.source_id === PLAIN_MEMORY).length, 1);
    assert.equal(store.memory_evidence.filter((row) => row.source_table === "media_assets").length, 2);
    assert.equal((await eraseEvidenceForMemory(makeClient(store) as any, { ownerId: OWNER, memoryId: PLAIN_MEMORY, now })).state, "done");
    assert.deepEqual(store.memory_evidence, []);
  });

  it("purge_first never retires an unlinked episode just because a different episode has a link", async () => {
    const store = fixture(false, 2);
    store.memory_evidence.push({ id: "linked-first", episode_id: episodeId(1), user_id: OWNER, source_table: "memories", source_id: PLAIN_MEMORY });
    const result = await erase(store, "purge_first", { purgeMutation: () => ({ data: [], error: null }) }, [episodeId(1), episodeId(2)]);
    assert.equal(result.state, "failed");
    assertRetired(store, episodeId(1));
    assert.equal(store.memory_episodes.find((row) => row.id === episodeId(2)).state, "confirmed");
    assert.equal(store.memory_evidence.length, 5);
  });

  it("purge_first preserves a link that appears after its initial order check", async () => {
    const store = fixture(false);
    let linkReads = 0;
    const result = await erase(store, "purge_first", { memoryRead: (table, selected, rows) => {
      if (table !== "memory_evidence" || !selected?.includes("source_table")) return;
      linkReads++;
      if (linkReads === 1) {
        store.memory_evidence.push({ id: "concurrent-link", episode_id: episodeId(1), user_id: OWNER, source_table: "memories", source_id: PLAIN_MEMORY });
        return { data: rows, error: null };
      }
      return undefined;
    } });
    assert.equal(result.state, "failed");
    assert.equal(store.memory_evidence.length, 3);
    assert.equal(store.memory_episodes.find((row) => row.id === episodeId(1)).state, "confirmed");
    assert.equal((await erase(store, "purge_first")).state, "done");
    assertRetired(store);
    assert.deepEqual(store.memory_evidence, []);
  });

  it("the Keep route returns unavailable and retains an existing link after an unproven retirement", async () => {
    app = await start();
    const { memoryId, episodeId: keptEpisode } = await keepEvening(app);
    app.store.memories.find((row) => row.id === memoryId).state = "deleted";
    const before = structuredClone(evidenceOf(app, keptEpisode));
    _setTestClient(makeClient(app.store, { retireMutation: () => ({ data: null, error: null }) }) as any, true);
    assert.equal((await call(app, "POST", `/api/me/memory-candidates/${keptEpisode}/confirm`, {})).status, 503);
    assert.deepEqual(evidenceOf(app, keptEpisode), before);
    _setTestClient(makeClient(app.store) as any, true);
    assert.equal((await call(app, "POST", `/api/me/memory-candidates/${keptEpisode}/confirm`, {})).status, 409);
    assertRetired(app.store, keptEpisode);
    assert.deepEqual(evidenceOf(app, keptEpisode), []);
  });

  it("the DELETE route records unproven retirement and a real redrive finishes cleanup", async () => {
    app = await start();
    const { memoryId, episodeId: keptEpisode } = await keepEvening(app);
    const before = structuredClone(evidenceOf(app, keptEpisode));
    _setTestClient(makeClient(app.store, { retireMutation: () => ({ data: [], error: null }) }) as any, true);
    assert.equal((await call(app, "DELETE", `/api/memories/${memoryId}`)).status, 204);
    const report = lifecycleReport(app);
    assert.equal(report.completed, false);
    assert.equal(report.deadLetterDurable, true);
    assert.deepEqual(evidenceOf(app, keptEpisode), before);
    assert.equal(step(report, "RAW_EVIDENCE_PURGED").attempts, 3);
    app.store.feature_flags.push({ flag: "memory_deletion_redrive_enabled", enabled: true });
    const redrive = await runMemoryDeletionRedrivePass({ client: makeClient(app.store), now });
    assert.deepEqual([redrive.resolved, redrive.stillFailing, redrive.unreadable], [1, 0, 0]);
    assertRetired(app.store, keptEpisode);
    assert.deepEqual(evidenceOf(app, keptEpisode), []);
    assert.equal(app.store.memory_deletion_dead_letters[0].resolved_at, now.toISOString());
  });

  for (const failure of ["error", "null", "throw", "remaining capture", "applied delete with null response"]) {
    it(`a final-anchor ${failure} must retain durable retry discoverability`, async () => {
      const store = fixture(true);
      let anchorDeleted = false;
      let finalConfirmations = 0;
      const options: FakeOpts = {
        purgeMutation: (rows) => {
          store.memory_evidence = store.memory_evidence.filter((row) => !rows.includes(row));
          if (rows.some((row) => row.source_table === "memories")) {
            anchorDeleted = true;
            if (failure === "remaining capture" || failure === "applied delete with null response") {
              store.memory_evidence.push({ id: "late-capture", episode_id: episodeId(1), user_id: OWNER, source_table: "media_assets", source_id: m(99) });
            }
            if (failure === "applied delete with null response") return { data: null, error: null };
          }
          return { data: rows.map((row) => ({ id: row.id })), error: null };
        },
        memoryRead: (table, selected) => {
          if (!anchorDeleted || table !== "memory_evidence" || selected !== "id") return;
          finalConfirmations++;
          const pending = readRetryDetail(store.memory_deletion_dead_letters[0].detail);
          assert.equal(pending.ok, true);
          if (pending.ok) assert.ok(pending.checkpoints.some((entry) => entry.episodeId === episodeId(1)));
          if (failure === "throw") throw new Error("final confirmation connection reset");
          if (failure === "error") return { data: null, error: { code: "57014", message: "final confirmation timeout" } };
          if (failure === "null") return { data: null, error: null };
          return undefined;
        },
      };
      const lifecycleOptions = { memoryId: PLAIN_MEMORY, ownerId: OWNER, actorUserId: OWNER, previous: { visibility: "only_me" as const, state: "published" as const }, now };
      const report = await runMemoryDeletionLifecycle(makeClient(store, options) as any, lifecycleOptions);
      assert.equal(anchorDeleted, true);
      if (failure === "remaining capture" || failure === "applied delete with null response") {
        assert.equal(report.completed, true);
        assert.equal(step(report, "RAW_EVIDENCE_PURGED").attempts, 2);
        assert.ok(finalConfirmations >= 2);
        assertRetired(store);
        assert.deepEqual(store.memory_evidence, []);
        const acknowledged = readRetryDetail(store.memory_deletion_dead_letters[0].detail);
        assert.equal(acknowledged.ok, true);
        if (acknowledged.ok) assert.deepEqual(acknowledged.checkpoints, []);
        assert.equal(store.memory_deletion_dead_letters[0].resolved_at, now.toISOString());
        return;
      }
      assert.equal(report.completed, false);
      assert.equal(report.deadLetterDurable, true);
      assert.equal(store.memory_deletion_dead_letters[0].resolved_at, null);
      if (failure !== "applied delete with null response") assert.ok(finalConfirmations > 0);
      const freshClient = makeClient(store);
      const retried = await runMemoryDeletionLifecycle(freshClient as any, lifecycleOptions);
      assert.equal(retried.completed, true);
      assertRetired(store);
      assert.deepEqual(store.memory_evidence, []);
      assert.equal(store.memory_deletion_dead_letters[0].resolved_at, now.toISOString());
    });
  }

  const checkpointInput = (id = episodeId(1)) => ({ memoryId: PLAIN_MEMORY, ownerId: OWNER, episodeId: id, now });
  const pendingOf = (store: Record<string, any[]>) => {
    const detail = readRetryDetail(store.memory_deletion_dead_letters[0].detail);
    assert.equal(detail.ok, true);
    return detail.checkpoints;
  };

  it("a fresh-client redrive resumes a durable checkpoint after the final link is gone", async () => {
    const store = fixture(true);
    const result = await eraseEvidenceForMemory(makeClient(store, { memoryRead: (table, selected) => {
      if (table === "memory_evidence" && selected === "id" && store.memory_evidence.length === 0) {
        throw new Error("process interrupted after final anchor deletion");
      }
      return undefined;
    } }) as any, { memoryId: PLAIN_MEMORY, ownerId: OWNER, now });
    assert.equal(result.state, "failed");
    assert.deepEqual(store.memory_evidence, []);
    assert.equal(pendingOf(store)[0].episodeId, episodeId(1));
    const durableStore = structuredClone(store);
    durableStore.memory_evidence.push({ id: "late-capture", episode_id: episodeId(1), user_id: OWNER, source_table: "media_assets", source_id: m(99) });
    durableStore.feature_flags.push({ flag: "memory_deletion_redrive_enabled", enabled: true });
    let discoveryReads = 0;
    const report = await runMemoryDeletionRedrivePass({ now, client: makeClient(durableStore, { evidenceLinkRead: (rows) => {
      discoveryReads++;
      assert.deepEqual(pendingOf(durableStore), []);
      assert.deepEqual(durableStore.memory_evidence, []);
      return { data: rows, error: null };
    } }) });
    assert.deepEqual([report.resolved, report.stillFailing, report.unreadable], [1, 0, 0]);
    assert.equal(discoveryReads, 1);
    assertRetired(durableStore);
    assert.deepEqual(durableStore.memory_evidence, []);
  });

  for (const mode of ["upsert", "update"]) {
    it(`an applied checkpoint ${mode} with a null reply retains the final anchor`, async () => {
      const store = fixture(true);
      if (mode === "update") assert.equal((await saveEpisodeCheckpoint(makeClient(store), checkpointInput())).ok, true);
      const result = await erase(store, "retire_first", { deadLetterMutationResponse: (operation) =>
        operation === mode ? { data: null, error: null } : undefined });
      assert.equal(result.state, "failed");
      assert.equal(store.memory_evidence.length, 1);
      assert.equal(store.memory_evidence[0].source_table, "memories");
      assert.equal(pendingOf(store)[0].episodeId, episodeId(1));
      const durableStore = structuredClone(store);
      assert.equal((await eraseEvidenceForMemory(makeClient(durableStore) as any, { memoryId: PLAIN_MEMORY, ownerId: OWNER, now })).state, "done");
      assert.deepEqual(durableStore.memory_evidence, []);
      assert.deepEqual(pendingOf(durableStore), []);
    });
  }

  for (const code of ["42P01", "PGRST205", "57014"]) {
    it(`checkpoint storage ${code} prevents anchor removal and empty-link completion`, async () => {
      const store = fixture(true);
      const options: FakeOpts = { deadLetterSnapshotRead: () => ({ data: null, error: { code, message: "checkpoint unavailable" } }) };
      const result = await erase(store, "retire_first", options);
      assert.equal(result.state, "failed");
      assert.equal(store.memory_evidence.filter((row) => row.source_table === "memories").length, 1);
      const emptyStore = fixture(false, 0);
      assert.equal((await eraseEvidenceForMemory(makeClient(emptyStore, options) as any, { memoryId: PLAIN_MEMORY, ownerId: OWNER, now })).state, "failed");
    });
  }

  it("checkpoint capacity fails before anchor removal without truncating existing entries", async () => {
    const store = fixture(true, MAX_EPISODE_CHECKPOINTS + 1);
    for (let index = 1; index <= MAX_EPISODE_CHECKPOINTS; index++) {
      assert.equal((await saveEpisodeCheckpoint(makeClient(store), checkpointInput(episodeId(index)))).ok, true);
    }
    const before = structuredClone(store.memory_deletion_dead_letters);
    const result = await erase(store, "retire_first", {}, [episodeId(MAX_EPISODE_CHECKPOINTS + 1)]);
    assert.equal(result.state, "failed");
    if (result.state === "failed") assert.match(result.detail, /capacity/);
    assert.deepEqual(store.memory_deletion_dead_letters, before);
    assert.equal(store.memory_evidence.filter((row) => row.episode_id === episodeId(MAX_EPISODE_CHECKPOINTS + 1) && row.source_table === "memories").length, 1);
    const completed = await eraseEvidenceForMemory(makeClient(store) as any, { memoryId: PLAIN_MEMORY, ownerId: OWNER, now });
    assert.equal(completed.state, "done");
    assert.deepEqual(store.memory_evidence, []);
    assert.deepEqual(pendingOf(store), []);
  });

  it("a stale acknowledgment cannot remove a newer token written after its snapshot", async () => {
    const store = fixture(true);
    const saved = await saveEpisodeCheckpoint(makeClient(store), checkpointInput());
    assert.equal(saved.ok, true);
    if (!saved.ok) return;
    let replacement: any;
    let writes = 0;
    const result = await acknowledgeEpisodeCheckpoint(makeClient(store, { beforeDeadLetterWrite: async () => {
      writes++;
      assert.equal(writes, 1);
      replacement = await saveEpisodeCheckpoint(makeClient(store), checkpointInput());
      assert.equal(replacement.ok, true);
    } }), { ...checkpointInput(), checkpoint: saved.checkpoint });
    assert.equal(result.ok, false);
    assert.match(result.detail, /changed or was lost/);
    assert.deepEqual(pendingOf(store), [replacement.checkpoint]);
    assert.equal(store.memory_deletion_dead_letters[0].resolved_at, null);
  });

  it("persistent checkpoint CAS conflicts are bounded and keep the anchor", async () => {
    const store = fixture(true);
    assert.equal((await saveEpisodeCheckpoint(makeClient(store), checkpointInput())).ok, true);
    let writes = 0;
    const result = await erase(store, "retire_first", { beforeDeadLetterWrite: async () => {
      writes++;
      assert.ok(writes <= 3);
      assert.equal((await saveEpisodeCheckpoint(makeClient(store), checkpointInput())).ok, true);
    } });
    assert.equal(result.state, "failed");
    assert.equal(writes, 3);
    assert.equal(store.memory_evidence.filter((row) => row.source_table === "memories").length, 1);
    assert.equal(pendingOf(store).length, 1);
  });

  for (const detail of [
    "[memory-evidence:v1:required] [memory-episodes:v2] []\nunknown",
    "[memory-evidence:v1:required] [memory-episodes:v1] [\ntruncated",
    "[memory-evidence:v1:required] [memory-episodes:v1] [[\"bad\",\"bad\"]]\ninvalid",
    "[memory-evidence:v1:absent] [memory-episodes:v1] []\ncontradictory",
    "[memory-evidence:v2:required] [memory-episodes:v1] []\nunknown outer version",
    "[memory-evidence:v2:required] unknown outer version without an inner checkpoint",
  ]) {
    it(`malformed checkpoint cannot become a legacy empty receipt: ${detail.split("\n")[0]}`, async () => {
      const store = fixture(true);
      assert.equal((await saveEpisodeCheckpoint(makeClient(store), checkpointInput())).ok, true);
      store.memory_deletion_dead_letters[0].detail = detail;
      const before = structuredClone(store);
      const result = await eraseEvidenceForMemory(makeClient(store) as any, { memoryId: PLAIN_MEMORY, ownerId: OWNER, now });
      assert.equal(result.state, "failed");
      assert.deepEqual(store, before);
      const report = await runMemoryDeletionLifecycle(makeClient(store) as any, {
        memoryId: PLAIN_MEMORY, ownerId: OWNER, actorUserId: OWNER, previous: { state: "published" }, now,
      });
      assert.equal(report.completed, false);
      assert.equal(report.deadLetterDurable, false);
      assert.equal(store.memory_deletion_dead_letters[0].detail, detail);
    });
  }

  it("failure diagnostics cannot truncate an episode checkpoint", async () => {
    const store = fixture(true);
    const report = await runMemoryDeletionLifecycle(makeClient(store, { memoryRead: (table, selected) => {
      if (table === "memory_evidence" && selected === "id" && store.memory_evidence.length === 0) {
        return { data: null, error: { code: "57014", message: "x".repeat(6000) } };
      }
      return undefined;
    } }) as any, { memoryId: PLAIN_MEMORY, ownerId: OWNER, actorUserId: OWNER, previous: { state: "published" }, now });
    assert.equal(report.completed, false);
    assert.equal(report.deadLetterDurable, true);
    assert.equal(store.memory_deletion_dead_letters[0].detail.length, 4000);
    assert.equal(pendingOf(store)[0].episodeId, episodeId(1));
    assert.equal(store.memory_deletion_dead_letters[0].resolved_at, null);
  });

  it("failure recording preserves checkpoints inserted after its snapshot", async () => {
    const store = fixture(true, 2);
    let recordWrites = 0;
    const report = await runMemoryDeletionLifecycle(makeClient(store, {
      failReads: new Set(["memory_evidence"]),
      beforeDeadLetterWrite: async (_mode, payload) => {
        if (!payload.failed_steps) return;
        recordWrites++;
        if (recordWrites === 1) assert.equal((await saveEpisodeCheckpoint(makeClient(store), checkpointInput(episodeId(2)))).ok, true);
      },
    }) as any, { memoryId: PLAIN_MEMORY, ownerId: OWNER, actorUserId: OWNER, previous: { state: "published" }, now });
    assert.equal(report.completed, false);
    assert.equal(report.deadLetterDurable, true);
    assert.equal(recordWrites, 2);
    assert.equal(pendingOf(store)[0].episodeId, episodeId(2));
    assert.equal(store.memory_deletion_dead_letters[0].resolved_at, null);
  });

  it("resolution cannot close a checkpoint inserted after its fresh snapshot", async () => {
    const store = fixture(false);
    const saved = await saveEpisodeCheckpoint(makeClient(store), checkpointInput());
    assert.equal(saved.ok, true);
    if (!saved.ok) return;
    assert.equal((await acknowledgeEpisodeCheckpoint(makeClient(store), { ...checkpointInput(), checkpoint: saved.checkpoint })).ok, true);
    let resolutionWrites = 0;
    const report = await runMemoryDeletionLifecycle(makeClient(store, { beforeDeadLetterWrite: async (_mode, payload) => {
      if (payload.resolved_at == null) return;
      resolutionWrites++;
      assert.equal((await saveEpisodeCheckpoint(makeClient(store), checkpointInput())).ok, true);
    } }) as any, { memoryId: PLAIN_MEMORY, ownerId: OWNER, actorUserId: OWNER, previous: { state: "published" }, now });
    assert.equal(resolutionWrites, 1);
    assert.equal(report.completed, false);
    assert.equal(report.deadLetterDurable, true);
    assert.equal(pendingOf(store)[0].episodeId, episodeId(1));
    assert.equal(store.memory_deletion_dead_letters[0].resolved_at, null);
    assert.equal(store.memory_evidence.length, 2);
  });

  it("the scheduler keeps a live Memory's pending checkpoint operator-visible without erasing it", async () => {
    const store = fixture(true);
    assert.equal((await saveEpisodeCheckpoint(makeClient(store), checkpointInput())).ok, true);
    store.memories[0].state = "published";
    store.feature_flags.push({ flag: "memory_deletion_redrive_enabled", enabled: true });
    const evidence = structuredClone(store.memory_evidence);
    const checkpoints = pendingOf(store);
    const report = await runMemoryDeletionRedrivePass({ client: makeClient(store), now });
    assert.deepEqual([report.needsOperator, report.moot, report.resolved, report.unreadable], [1, 0, 0, 0]);
    assert.deepEqual(store.memory_evidence, evidence);
    assert.deepEqual(pendingOf(store), checkpoints);
    assert.equal(store.memory_deletion_dead_letters[0].resolved_at, null);
  });

  for (const loss of ["missing row", "legacy replacement"]) {
    it(`a ${loss} after confirmed checkpoint save cannot turn an in-run retry into empty success`, async () => {
      const store = fixture(true);
      let lost = false;
      const report = await runMemoryDeletionLifecycle(makeClient(store, { memoryRead: (table, selected) => {
        if (!lost && table === "memory_evidence" && selected === "id" && store.memory_evidence.length === 0) {
          lost = true;
          if (loss === "missing row") store.memory_deletion_dead_letters = [];
          else store.memory_deletion_dead_letters[0].detail = "[memory-evidence:v1:required] legacy replacement";
          return { data: null, error: { code: "57014", message: "final confirmation unavailable" } };
        }
        return undefined;
      } }) as any, { memoryId: PLAIN_MEMORY, ownerId: OWNER, actorUserId: OWNER, previous: { state: "published" }, now });
      assert.equal(lost, true);
      assert.equal(report.completed, false);
      assert.equal(report.deadLetterDurable, true);
      assert.match(step(report, "RAW_EVIDENCE_PURGED").detail, /receipt was lost/);
      assert.equal(pendingOf(store)[0].episodeId, episodeId(1));
      assert.deepEqual(store.memory_evidence, []);
      const durableStore = structuredClone(store);
      assert.equal((await runMemoryDeletionLifecycle(makeClient(durableStore) as any, {
        memoryId: PLAIN_MEMORY, ownerId: OWNER, actorUserId: OWNER, previous: { state: "published" }, now,
      })).completed, true);
      assert.deepEqual(pendingOf(durableStore), []);
    });
  }

  it("an applied acknowledgment with a malformed reply is not reported as confirmed", async () => {
    const store = fixture(true);
    const result = await erase(store, "retire_first", { deadLetterMutationResponse: (_mode, payload) => {
      const detail = readRetryDetail(payload.detail);
      return detail.ok && detail.versioned && detail.checkpoints.length === 0 ? { data: null, error: null } : undefined;
    } });
    assert.equal(result.state, "failed");
    if (result.state === "failed") assert.match(result.detail, /acknowledgment returned malformed/);
    assert.deepEqual(store.memory_evidence, []);
    assert.deepEqual(pendingOf(store), []);
    assertRetired(store);
  });

  it("a checkpoint write failure leaves the final anchor available", async () => {
    const store = fixture(true);
    const result = await erase(store, "retire_first", { failWrites: new Set(["memory_deletion_dead_letters:upsert"]) });
    assert.equal(result.state, "failed");
    assert.equal(store.memory_evidence.length, 1);
    assert.equal(store.memory_evidence[0].source_table, "memories");
    assert.equal((store.memory_deletion_dead_letters ?? []).length, 0);
  });

  it("a checkpoint insert conflict preserves another episode before retrying the save", async () => {
    const store = fixture(true, 2);
    let inserts = 0;
    const saved = await saveEpisodeCheckpoint(makeClient(store, { beforeDeadLetterWrite: async (mode) => {
      if (mode !== "upsert") return;
      inserts++;
      assert.equal((await saveEpisodeCheckpoint(makeClient(store), checkpointInput(episodeId(2)))).ok, true);
    } }), checkpointInput());
    assert.equal(saved.ok, true);
    assert.equal(inserts, 1);
    assert.deepEqual(pendingOf(store).map((entry) => entry.episodeId).sort(), [episodeId(1), episodeId(2)]);
  });

  it("another owner's checkpoint row blocks cleanup without mutation", async () => {
    const store = fixture(true);
    assert.equal((await saveEpisodeCheckpoint(makeClient(store), { ...checkpointInput(), ownerId: OTHER })).ok, true);
    const before = structuredClone(store);
    const result = await eraseEvidenceForMemory(makeClient(store) as any, { ownerId: OWNER, memoryId: PLAIN_MEMORY, now });
    assert.equal(result.state, "failed");
    assert.deepEqual(store, before);
  });

  for (const failure of ["null mutation reply", "late evidence"]) {
    it(`the unlinked Keep route checkpoints ${failure} and a fresh lifecycle recovers`, async () => {
      app = await start();
      assert.equal((await detect(app)).status, 200);
      const candidate = evening(app);
      _setTestClient(makeClient(app.store, { failWrites: new Set(["memory_evidence:upsert"]) }) as any, true);
      assert.equal((await call(app, "POST", `/api/me/memory-candidates/${candidate.id}/confirm`, {})).status, 503);
      const memory = app.store.memories.find((row) => row.owner_id === OWNER && row.id !== PLAIN_MEMORY);
      assert.ok(memory);
      assert.ok(evidenceOf(app, candidate.id).every((row) => row.source_table !== "memories"));
      _setTestClient(makeClient(app.store) as any, true);
      assert.equal((await call(app, "DELETE", `/api/memories/${memory.id}`)).status, 204);
      assert.equal(candidate.state, "confirmed");
      const store = app.store;
      _setTestClient(makeClient(store, { retireMutation: (rows, payload) => {
        for (const row of rows) Object.assign(row, payload);
        store.memory_evidence.push({
          id: "late-unlinked-capture", episode_id: candidate.id, user_id: OWNER,
          source_table: "media_assets", source_id: m(99),
        });
        return { data: failure === "null mutation reply" ? null : rows.map((row) => ({ id: row.id })), error: null };
      } }) as any, true);
      const refused = await call(app, "POST", `/api/me/memory-candidates/${candidate.id}/confirm`, {});
      assert.equal(refused.status, 503, JSON.stringify(refused.body));
      assertRetired(store, candidate.id);
      assert.deepEqual(evidenceOf(app, candidate.id).map((row) => row.id), ["late-unlinked-capture"]);
      const letter = (store.memory_deletion_dead_letters ?? []).find((row) => row.memory_id === memory.id);
      assert.ok(letter, "an unlinked retired episode remains durably discoverable");
      const pending = readRetryDetail(letter.detail);
      assert.equal(pending.ok, true);
      assert.deepEqual(pending.checkpoints.map((entry) => entry.episodeId), [candidate.id]);
      assert.equal(letter.resolved_at, null);
      _setTestClient(makeClient(store) as any, true);
      assert.equal((await call(app, "POST", `/api/me/memory-candidates/${candidate.id}/confirm`, {})).status, 409);
      const durableStore = structuredClone(store);
      const resumedAt = new Date("2026-10-17T12:00:00.000Z");
      const resumed = await runMemoryDeletionLifecycle(makeClient(durableStore) as any, {
        memoryId: memory.id, ownerId: OWNER, actorUserId: OWNER, previous: { state: "published" }, now: resumedAt,
      });
      assert.equal(resumed.completed, true);
      assertRetired(durableStore, candidate.id);
      assert.deepEqual(durableStore.memory_evidence.filter((row) => row.episode_id === candidate.id), []);
      const receipt = durableStore.memory_deletion_dead_letters.find((row) => row.memory_id === memory.id);
      const acknowledged = readRetryDetail(receipt.detail);
      assert.equal(acknowledged.ok, true);
      assert.deepEqual(acknowledged.checkpoints, []);
      assert.equal(receipt.resolved_at, resumedAt.toISOString());
      assert.equal(durableStore.memories.find((row) => row.id === memory.id).state, "deleted");
    });
  }

  it("an unlinked purge_first with a Memory identity cannot retire when checkpoint storage is unavailable", async () => {
    const store = fixture(false);
    const result = await retireEpisodesAndPurgeEvidence(makeClient(store, {
      absent: new Set(["memory_deletion_dead_letters"]),
    }) as any, { ownerId: OWNER, memoryId: PLAIN_MEMORY, episodeIds: [episodeId(1)], now, order: "purge_first" });
    assert.equal(result.state, "failed");
    if (result.state === "failed") assert.match(result.detail, /episode checkpoint read/);
    assert.equal(store.memory_episodes.find((row) => row.id === episodeId(1)).state, "confirmed");
    assert.deepEqual(store.memory_evidence, []);
  });

  for (const failure of ["null mutation reply", "failed retirement confirmation"]) {
    it(`an unlinked Keep's ${failure} retains its pre-retirement checkpoint`, async () => {
      const store = fixture(false);
      const options: FakeOpts = failure === "null mutation reply" ? { retireMutation: (rows, payload) => {
        for (const row of rows) Object.assign(row, payload);
        return { data: null, error: null };
      } } : { memoryRead: (table, selected) => {
        if (table === "memory_episodes" && selected?.includes("merged_into_id")) return { data: null, error: { code: "57014", message: "retirement confirmation unavailable" } };
        return undefined;
      } };
      const result = await retireEpisodesAndPurgeEvidence(makeClient(store, options) as any, {
        ownerId: OWNER, memoryId: PLAIN_MEMORY, episodeIds: [episodeId(1)], now, order: "purge_first",
      });
      assert.equal(result.state, "failed");
      assertRetired(store);
      assert.deepEqual(store.memory_evidence, []);
      assert.equal(pendingOf(store)[0].episodeId, episodeId(1));
      const durableStore = structuredClone(store);
      assert.equal((await runMemoryDeletionLifecycle(makeClient(durableStore) as any, {
        memoryId: PLAIN_MEMORY, ownerId: OWNER, actorUserId: OWNER, previous: { state: "published" }, now,
      })).completed, true);
      assert.deepEqual(pendingOf(durableStore), []);
      assert.equal(durableStore.memory_deletion_dead_letters[0].resolved_at, now.toISOString());
    });
  }
});
