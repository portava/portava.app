/**
 * placesMergeLog.test.ts — the admin place MERGE and UNMERGE never leave a
 * change that `place_merge_log` does not record, and never answer success for
 * one.
 *
 * Lane PLACES-MERGE-LOG (B58). Found by lane MEM-PLACE-SPLIT: in
 * `routes/placesCanonical.ts` the merge and unmerge handlers awaited their
 * `place_merge_log` insert and discarded its result, and neither read
 * `external_places_enabled`, the flag the file's own header says gates it.
 *
 * WHAT MAIN DID (3c214ca80), measured by this file:
 *   - merge wrote the place FIRST and the log row SECOND, ignoring the log's
 *     error: a failed log write answered 200 and left the place merged with no
 *     record of it;
 *   - unmerge did the same, so a place could come back to `active` unrecorded;
 *   - unmerge never read the log at all — a merge nobody recorded could be
 *     reversed as if it had been;
 *   - neither was flag-gated (ingest and the canonical read are);
 *   - a failed place read was answered 404 "Place not found", and a failed
 *     reference count was logged as `ref_count: 0`;
 *   - re-merging an already-merged place silently re-pointed it, and a place
 *     changed by a concurrent request was overwritten.
 *
 * THE SUBJECT is the real router over HTTP. The service client is the REAL
 * supabase-js client over `helpers/postgrestOracle.ts`, which APPLIES writes,
 * so every test reads the state a request actually left and the order of the
 * requests it actually issued. The caller's own client (token, account gate,
 * the shared admin guard's role read) is `helpers/failClosedSupabase.ts`, as in
 * adminGuardSharedPath.test.ts.
 *
 * Runtime: node:test. Binds 127.0.0.1, so run it outside a sandbox that blocks
 * listen(2):
 *   SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *   node --import tsx/esm --test src/test/placesMergeLog.test.ts
 */

import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { randomUUID } from "node:crypto";
import express from "express";
import type { Express } from "express";

import { _setTestClient, _clearTestClient } from "../lib/http.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import { makeFailClosedClient } from "./helpers/failClosedSupabase.js";
import { makeOracle, type OracleHandle } from "./helpers/postgrestOracle.js";
import placesCanonicalRouter from "../routes/placesCanonical.js";

// ── Fixtures ──────────────────────────────────────────────────────────────────

const CALLER = "11111111-1111-4111-8111-111111111111";
const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"; // the place merged away
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"; // the survivor
const C = "cccccccc-cccc-4ccc-8ccc-cccccccccccc"; // another survivor
const TOKEN = "places-merge-log-token";
const FLAG = "external_places_enabled";

type Row = Record<string, any>;
type DbError = { code: string; message: string };

const active = (id: string): Row => ({ id, name: `place ${id.slice(0, 4)}`, status: "active", merged_into_place_id: null });
const mergedInto = (id: string, into: string): Row => ({ ...active(id), status: "duplicate", merged_into_place_id: into });
const logRow = (action: string, survivor: string, affected: string, at: string): Row => ({
  id: randomUUID(), action, survivor_place_id: survivor, affected_place_id: affected,
  admin_id: CALLER, ref_count: 0, created_at: at,
});
const REFS: Row[] = [
  { id: randomUUID(), place_id: A, provider: "fsq", provider_place_id: "fsq-a1" },
  { id: randomUUID(), place_id: A, provider: "osm", provider_place_id: "osm-a2" },
  { id: randomUUID(), place_id: B, provider: "fsq", provider_place_id: "fsq-b1" },
];

/**
 * `place_merge_log` with the two column defaults the database supplies
 * (`id DEFAULT gen_random_uuid()`, `created_at DEFAULT now()`), so a row the
 * route inserts looks like the row the database would store. The clock is
 * monotonic and later than every seeded row.
 */
let clock = Date.parse("2026-10-14T12:00:00.000Z");
class WithDbDefaults extends Array<Row> {
  static get [Symbol.species](): ArrayConstructor { return Array; }
  override push(...rows: Row[]): number {
    for (const r of rows) {
      r.id ??= randomUUID();
      r.created_at ??= new Date((clock += 1000)).toISOString();
    }
    return super.push(...rows);
  }
}

interface SeenRequest { method: string; table: string; url: string; body: any }

interface WorldSpec {
  places: Row[];
  log?: Row[];
  /** true (default) / false = a FALSE row / "absent" = no row at all. */
  flag?: boolean | "absent";
  /** Return a PostgREST error to make THIS request fail, as the server would answer it. */
  fail?: (r: SeenRequest) => DbError | null | undefined;
  /** Runs before a request is served, against the live tables — a concurrent writer. */
  before?: (r: SeenRequest, tables: Record<string, Row[]>) => void;
}

interface World {
  oracle: OracleHandle;
  place(id: string): Row;
  log(): Row[];
  /** "METHOD table" for every request that was not a read, in issue order. */
  writes(): string[];
}

function tableOf(url: string): string {
  return new URL(url).pathname.replace(/^\/rest\/v1\//, "");
}

function makeWorld(spec: WorldSpec): World {
  const log = new WithDbDefaults();
  for (const r of spec.log ?? []) log.push({ ...r });
  const tables: Record<string, Row[]> = {
    places: spec.places.map((r) => ({ ...r })),
    place_merge_log: log,
    external_place_references: REFS.map((r) => ({ ...r })),
    feature_flags: spec.flag === "absent" ? [] : [{ flag: FLAG, enabled: spec.flag ?? true }],
  };
  // The oracle reads `failReads[table]` and `failWrites[table]` once per request,
  // AFTER logging it and BEFORE serving it. Two proxies over one per-request
  // verdict turn that into a per-request hook without touching the oracle.
  let oracle: OracleHandle;
  let decidedFor = 0;
  let verdict: DbError | undefined;
  const decide = (table: string): DbError | undefined => {
    if (oracle.log.length !== decidedFor) {
      decidedFor = oracle.log.length;
      const last = oracle.log[decidedFor - 1]!;
      const seen: SeenRequest = { method: last.method, table, url: last.url, body: last.body ? JSON.parse(last.body) : null };
      spec.before?.(seen, tables);
      verdict = spec.fail?.(seen) ?? undefined;
    }
    return verdict;
  };
  const hook = new Proxy({}, { get: (_t, key) => (typeof key === "string" ? decide(key) : undefined) });
  oracle = makeOracle({ tables, failReads: hook as any, failWrites: hook as any });
  return {
    oracle,
    place: (id) => tables.places!.find((p) => p.id === id)!,
    log: () => [...tables.place_merge_log!],
    writes: () =>
      oracle.log.filter((l) => l.method !== "GET" && l.method !== "HEAD").map((l) => `${l.method} ${tableOf(l.url)}`),
  };
}

const BROKEN: DbError = { code: "57P01", message: "terminating connection due to administrator command" };
const failWhen = (method: string, table: string) => (r: SeenRequest) =>
  r.method === method && r.table === table ? BROKEN : null;

// ── HTTP plumbing ─────────────────────────────────────────────────────────────

interface Reply { status: number; body: any }

function request(base: string, path: string, body: unknown = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, base);
    const payload = JSON.stringify(body);
    const req = http.request(
      {
        hostname: url.hostname, port: Number(url.port), path: url.pathname, method: "POST",
        headers: {
          "content-type": "application/json", authorization: `Bearer ${TOKEN}`,
          "content-length": Buffer.byteLength(payload),
        },
      },
      (res) => {
        let raw = "";
        res.on("data", (c) => (raw += c));
        res.on("end", () => {
          let parsed: any;
          try { parsed = JSON.parse(raw); } catch { parsed = raw; }
          resolve({ status: res.statusCode ?? 0, body: parsed });
        });
      },
    );
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

const logged: Array<{ level: string; line: string }> = [];
function capturingLog(): any {
  const at = (level: string) => (...a: unknown[]) => { logged.push({ level, line: a.map((x) => JSON.stringify(x)).join(" ") }); };
  const l: any = { info: at("info"), warn: at("warn"), error: at("error"), debug: at("debug") };
  l.child = () => l;
  return l;
}

let base = "";
let server: http.Server;

before(async () => {
  const app: Express = express();
  app.use(express.json());
  app.use((req: any, _res, next) => { req.log = capturingLog(); next(); });
  app.use("/api", placesCanonicalRouter);
  server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  base = `http://127.0.0.1:${(server.address() as any).port}`;
});

after(async () => { await new Promise<void>((r) => server.close(() => r())); });

beforeEach(() => {
  _clearTestClient();
  _setTestServiceClient(null as any);
  logged.length = 0;
});

/** Install `world` as the service client and a caller holding `role`. */
function install(world: World, role = "admin"): void {
  _setTestClient(makeFailClosedClient({ users: { [TOKEN]: CALLER }, rows: { profiles: [{ id: CALLER, role }] } }), true);
  _setTestServiceClient(world.oracle.client);
}

const merge = (id = A, intoId = B) => request(base, `/api/admin/places/${id}/merge`, { intoId });
const unmerge = (id = A) => request(base, `/api/admin/places/${id}/unmerge`);

function refused(r: Reply, status: number, error: string, reason: string, what: string): void {
  assert.equal(r.status, status, `${what}: status — ${JSON.stringify(r.body)}`);
  assert.equal(r.body?.error, error, `${what}: error code — ${JSON.stringify(r.body)}`);
  assert.equal(r.body?.reason, reason, `${what}: reason — ${JSON.stringify(r.body)}`);
}

const unchangedActive = (w: World, id: string, what: string) => {
  assert.equal(w.place(id).merged_into_place_id, null, `${what}: ${id.slice(0, 4)} must not be merged`);
  assert.equal(w.place(id).status, "active", `${what}: ${id.slice(0, 4)} status must be unchanged`);
};
const stillMerged = (w: World, id: string, into: string, what: string) => {
  assert.equal(w.place(id).merged_into_place_id, into, `${what}: ${id.slice(0, 4)} must still be merged into ${into.slice(0, 4)}`);
  assert.equal(w.place(id).status, "duplicate", `${what}: status must be unchanged`);
};

const findP = (t: Record<string, Row[]>, id: string): Row => t.places!.find((p) => p.id === id)!;
/** Another request's complete, LOGGED move of `id` — it logs first, then moves, as every writer here does. */
function concurrentMove(t: Record<string, Row[]>, action: "merge" | "unmerge", id: string, survivor: string): void {
  t.place_merge_log!.push({ action, survivor_place_id: survivor, affected_place_id: id, admin_id: CALLER, ref_count: 0 });
  Object.assign(findP(t, id), action === "merge" ? { merged_into_place_id: survivor, status: "duplicate" } : { merged_into_place_id: null, status: "active" });
}

// ── MERGE ─────────────────────────────────────────────────────────────────────

describe("POST /admin/places/:id/merge", () => {
  it("M1 records the merge BEFORE it applies it, and answers the same body as before", async () => {
    const w = makeWorld({ places: [active(A), active(B)] });
    install(w);
    const r = await merge();
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body, { ok: true, survivorId: B, mergedId: A });
    stillMerged(w, A, B, "M1");
    const rows = w.log();
    assert.equal(rows.length, 1, "M1: exactly one log row");
    assert.deepEqual(
      { action: rows[0]!.action, survivor: rows[0]!.survivor_place_id, affected: rows[0]!.affected_place_id, admin: rows[0]!.admin_id, refs: rows[0]!.ref_count },
      { action: "merge", survivor: B, affected: A, admin: CALLER, refs: 2 },
    );
    assert.deepEqual(w.writes(), ["POST place_merge_log", "PATCH places"], "M1: the log row is written first, then the place");
  });

  it("M2 a log row that cannot be written leaves the place UNMERGED and answers an error, not ok", async () => {
    const w = makeWorld({ places: [active(A), active(B)], fail: failWhen("POST", "place_merge_log") });
    install(w);
    const r = await merge();
    refused(r, 500, "db_error", "merge_log_write_failed", "M2");
    unchangedActive(w, A, "M2");
    assert.equal(w.log().length, 0, "M2: no log row");
    assert.ok(!w.writes().includes("PATCH places"), `M2: the place is never written — ${w.writes()}`);
  });

  it("M3 a place write that fails after the log row is written withdraws the log row", async () => {
    const w = makeWorld({ places: [active(A), active(B)], fail: failWhen("PATCH", "places") });
    install(w);
    const r = await merge();
    refused(r, 500, "db_error", "merge_write_failed", "M3");
    unchangedActive(w, A, "M3");
    assert.equal(w.log().length, 0, "M3: the log row for a merge that did not happen is withdrawn");
  });

  it("M4 when the withdrawal fails too, the answer names the orphan row and the operator log says so", async () => {
    const w = makeWorld({
      places: [active(A), active(B)],
      fail: (q) => (q.method === "PATCH" && q.table === "places") || (q.method === "DELETE" && q.table === "place_merge_log") ? BROKEN : null,
    });
    install(w);
    const r = await merge();
    refused(r, 500, "db_error", "merge_log_orphaned", "M4");
    unchangedActive(w, A, "M4");
    const rows = w.log();
    assert.equal(rows.length, 1, "M4: the orphan row is still there (the withdrawal failed)");
    assert.ok(String(r.body.message).includes(rows[0]!.id), `M4: the answer names the orphan row — ${r.body.message}`);
    assert.ok(
      logged.some((l) => l.level === "error" && l.line.includes(rows[0]!.id)),
      "M4: the orphan is logged at error level with its id",
    );
  });

  it("M5 a place changed by a concurrent request is not overwritten: 409, and our log row is withdrawn", async () => {
    let raced = false;
    const w = makeWorld({
      places: [active(A), active(B), active(C)],
      before: (q, t) => {
        if (raced || q.method === "GET" || q.method === "HEAD") return;
        raced = true; // someone else merges A into C just before our first write
        Object.assign(t.places!.find((p) => p.id === A)!, { merged_into_place_id: C, status: "duplicate" });
      },
    });
    install(w);
    const r = await merge();
    refused(r, 409, "conflict", "place_changed", "M5");
    stillMerged(w, A, C, "M5");
    assert.equal(w.log().filter((x) => x.survivor_place_id === B).length, 0, "M5: no log row claims the merge into B");
  });

  it("M6 an already-merged place is refused (unmerge it first), not silently re-pointed", async () => {
    const w = makeWorld({ places: [mergedInto(A, C), active(B), active(C)], log: [logRow("merge", C, A, "2026-10-01T00:00:00.000Z")] });
    install(w);
    const r = await merge();
    refused(r, 409, "conflict", "already_merged", "M6");
    stillMerged(w, A, C, "M6");
    assert.deepEqual(w.writes(), [], "M6: nothing is written");
  });

  it("M7 is gated by external_places_enabled: FALSE answers feature_disabled and writes nothing", async () => {
    const w = makeWorld({ places: [active(A), active(B)], flag: false });
    install(w);
    const r = await merge();
    assert.equal(r.status, 404, JSON.stringify(r.body));
    assert.equal(r.body?.error, "feature_disabled");
    unchangedActive(w, A, "M7");
    assert.deepEqual(w.oracle.log.map((l) => tableOf(l.url)), ["feature_flags"], "M7: the flag is the only thing read");
  });

  it("M8 an ABSENT or UNREADABLE flag is OFF", async () => {
    for (const [what, spec] of [
      ["absent", { flag: "absent" as const }],
      ["unreadable", { fail: failWhen("GET", "feature_flags") }],
    ] as const) {
      const w = makeWorld({ places: [active(A), active(B)], ...spec });
      install(w);
      const r = await merge();
      assert.equal(r.status, 404, `M8 ${what}: ${JSON.stringify(r.body)}`);
      assert.equal(r.body?.error, "feature_disabled", `M8 ${what}`);
      assert.deepEqual(w.writes(), [], `M8 ${what}: nothing is written`);
    }
  });

  it("M9 a place read that FAILS is answered as unavailable, not as 'Place not found', and writes nothing", async () => {
    const w = makeWorld({ places: [active(A), active(B)], fail: failWhen("GET", "places") });
    install(w);
    const r = await merge();
    refused(r, 503, "degraded_unavailable", "place_read_failed", "M9");
    assert.deepEqual(w.writes(), [], "M9: nothing is written");
  });

  it("M10 a reference count that FAILS refuses the merge rather than logging ref_count 0", async () => {
    const w = makeWorld({ places: [active(A), active(B)], fail: failWhen("HEAD", "external_place_references") });
    install(w);
    const r = await merge();
    refused(r, 503, "degraded_unavailable", "reference_count_failed", "M10");
    unchangedActive(w, A, "M10");
    assert.deepEqual(w.writes(), [], "M10: nothing is written");
  });

  it("M11 the refusals main already had are unchanged (not found, self-merge, merged target, bad ids)", async () => {
    const w = makeWorld({ places: [active(A), mergedInto(B, C), active(C)] });
    install(w);
    const missing = await merge(A, "dddddddd-dddd-4ddd-8ddd-dddddddddddd");
    assert.deepEqual([missing.status, missing.body?.error], [404, "not_found"], JSON.stringify(missing.body));
    const self = await merge(A, A);
    assert.deepEqual([self.status, self.body?.error], [400, "invalid_payload"], JSON.stringify(self.body));
    const target = await merge(A, B);
    assert.deepEqual([target.status, target.body?.error], [400, "invalid_payload"], JSON.stringify(target.body));
    const bad = await request(base, `/api/admin/places/not-a-uuid/merge`, { intoId: B });
    assert.deepEqual([bad.status, bad.body?.error], [400, "invalid_payload"], JSON.stringify(bad.body));
    assert.deepEqual(w.writes(), [], "M11: nothing is written");
  });

  it("M13 a place write that ERRORS but committed (the response was lost) keeps the log row and succeeds", async () => {
    const w = makeWorld({
      places: [active(A), active(B)],
      before: (q, t) => {
        if (q.method === "PATCH" && q.table === "places") Object.assign(t.places!.find((p) => p.id === A)!, { merged_into_place_id: B, status: "duplicate" });
      },
      fail: failWhen("PATCH", "places"),
    });
    install(w);
    const r = await merge();
    assert.equal(r.status, 200, `M13: ${JSON.stringify(r.body)}`);
    stillMerged(w, A, B, "M13");
    assert.equal(w.log().length, 1, "M13: the applied merge keeps its log row");
  });

  it("M14 a place write that ERRORS with an outcome that cannot be established KEEPS the log row and says so", async () => {
    // (a) the re-read fails; (b) the re-read finds the place merged somewhere else.
    for (const what of ["reread fails", "elsewhere"] as const) {
      let patched = false;
      const w = makeWorld({
        places: [active(A), active(B), active(C)],
        before: (q, t) => {
          if (q.method !== "PATCH" || q.table !== "places") return;
          patched = true;
          if (what === "elsewhere") Object.assign(t.places!.find((p) => p.id === A)!, { merged_into_place_id: C, status: "duplicate" });
        },
        fail: (q) => (q.method === "PATCH" && q.table === "places") || (what === "reread fails" && patched && q.method === "GET" && q.table === "places") ? BROKEN : null,
      });
      install(w);
      const r = await merge();
      refused(r, 500, "db_error", "merge_outcome_unknown", `M14 ${what}`);
      const rows = w.log();
      assert.equal(rows.length, 1, `M14 ${what}: the row is KEPT — withdrawing it could leave an applied merge unrecorded`);
      assert.ok(String(r.body.message).includes(rows[0]!.id), `M14 ${what}: the answer names the kept row`);
      assert.ok(!w.writes().includes("DELETE place_merge_log"), `M14 ${what}: no withdrawal is attempted`);
      assert.ok(logged.some((l) => l.level === "error" && l.line.includes(rows[0]!.id)), `M14 ${what}: logged at error level`);
    }
  });

  it("M15 (X1) an applied merge whose response was lost, reversed by a concurrent unmerge before the re-read, KEEPS its row", async () => {
    // The re-read sees the starting state, but the merge DID happen: a newer row
    // (the unmerge's) proves another request moved the place since ours.
    let patched = false;
    let reverted = false;
    const w = makeWorld({
      places: [active(A), active(B)],
      before: (q, t) => {
        if (q.method === "PATCH" && q.table === "places") { patched = true; Object.assign(findP(t, A), { merged_into_place_id: B, status: "duplicate" }); return; }
        if (patched && !reverted && q.method === "GET" && q.table === "places") { reverted = true; concurrentMove(t, "unmerge", A, B); }
      },
      fail: failWhen("PATCH", "places"),
    });
    install(w);
    refused(await merge(), 500, "db_error", "merge_outcome_unknown", "M15");
    unchangedActive(w, A, "M15");
    assert.deepEqual(w.log().map((x) => x.action), ["merge", "unmerge"], "M15: the applied merge keeps its row; the log matches what happened");
    assert.ok(!w.writes().includes("DELETE place_merge_log"), "M15: no withdrawal");
  });

  it("M16 a merge another request made inside the window is not claimed: the outcome is unknown, not 200", async () => {
    let patched = false;
    let raced = false;
    const w = makeWorld({
      places: [active(A), active(B)],
      before: (q, t) => {
        if (q.method === "PATCH" && q.table === "places") { patched = true; return; } // ours does NOT commit
        if (patched && !raced && q.method === "GET" && q.table === "places") { raced = true; concurrentMove(t, "merge", A, B); }
      },
      fail: failWhen("PATCH", "places"),
    });
    install(w);
    refused(await merge(), 500, "db_error", "merge_outcome_unknown", "M16");
    stillMerged(w, A, B, "M16");
    assert.equal(w.log().filter((x) => x.action === "merge").length, 2, "M16: both rows stay; ours is not withdrawn on a guess");
  });

  it("M17 a place other places are merged into is not merged away (no two-hop chain), with or without a race", async () => {
    const w = makeWorld({ places: [active(A), active(B), active(C)] });
    install(w);
    assert.equal((await merge(A, B)).status, 200, "M17: A into B");
    const r = await merge(B, C); // B is now a survivor: A→B→C would follow one hop only
    refused(r, 409, "conflict", "place_is_survivor", "M17");
    unchangedActive(w, B, "M17");
    assert.deepEqual(w.log().map((x) => `${x.action}:${x.affected_place_id.slice(0, 4)}`), ["merge:aaaa"], "M17: nothing written for B");
  });

  it("M18 a merged-in read that FAILS refuses the merge as unavailable", async () => {
    const w = makeWorld({ places: [active(A), active(B)], fail: failWhen("HEAD", "places") });
    install(w);
    refused(await merge(), 503, "degraded_unavailable", "place_read_failed", "M18");
    assert.deepEqual(w.writes(), [], "M18: nothing is written");
  });

  it("M19 a failed read of ONLY the place being merged away is unavailable, not 'Place not found' (V14)", async () => {
    const w = makeWorld({
      places: [active(A), active(B)],
      fail: (q) => (q.method === "GET" && q.table === "places" && q.url.includes(`id=eq.${A}`) ? BROKEN : null),
    });
    install(w);
    refused(await merge(), 503, "degraded_unavailable", "place_read_failed", "M19");
    assert.deepEqual(w.writes(), [], "M19: nothing is written");
  });

  it("M12 stays admin-only: a non-admin is refused before the catalog is touched", async () => {
    const w = makeWorld({ places: [active(A), active(B)] });
    install(w, "user");
    const r = await merge();
    assert.deepEqual([r.status, r.body?.error], [403, "forbidden"], JSON.stringify(r.body));
    assert.equal(w.oracle.requests(), 0, "M12: the service client is never used");
  });
});

// ── UNMERGE ───────────────────────────────────────────────────────────────────

const T1 = "2026-10-01T00:00:00.000Z";
const T2 = "2026-10-02T00:00:00.000Z";
const T3 = "2026-10-03T00:00:00.000Z";

describe("POST /admin/places/:id/unmerge", () => {
  it("U1 reverses a LOGGED merge, records the unmerge BEFORE applying it, and answers the same body", async () => {
    const w = makeWorld({ places: [mergedInto(A, B), active(B)], log: [logRow("merge", B, A, T1)] });
    install(w);
    const r = await unmerge();
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body, { ok: true, restoredId: A });
    unchangedActive(w, A, "U1");
    const rows = w.log();
    assert.equal(rows.length, 2, "U1: one new row");
    assert.deepEqual(
      { action: rows[1]!.action, survivor: rows[1]!.survivor_place_id, affected: rows[1]!.affected_place_id, admin: rows[1]!.admin_id },
      { action: "unmerge", survivor: B, affected: A, admin: CALLER },
    );
    assert.deepEqual(w.writes(), ["POST place_merge_log", "PATCH places"], "U1: the log row is written first, then the place");
  });

  it("U2 a merge with NO log row is refused cleanly (409), and the place stays merged", async () => {
    // A merge whose log write failed silently on main: merged, unrecorded. Also a
    // merge row for ANOTHER place must not count for this one.
    const w = makeWorld({ places: [mergedInto(A, B), active(B), mergedInto(C, B)], log: [logRow("merge", B, C, T1)] });
    install(w);
    const r = await unmerge();
    refused(r, 409, "conflict", "merge_not_logged", "U2");
    stillMerged(w, A, B, "U2");
    assert.deepEqual(w.writes(), [], "U2: nothing is written");
  });

  it("U3 the NEWEST log row decides: a merge naming another survivor refuses; one naming this survivor admits", async () => {
    const disagree = makeWorld({
      places: [mergedInto(A, B), active(B), active(C)],
      log: [logRow("merge", B, A, T1), logRow("unmerge", B, A, T2), logRow("merge", C, A, T3)],
    });
    install(disagree);
    refused(await unmerge(), 409, "conflict", "merge_log_disagrees", "U3 disagree");
    stillMerged(disagree, A, B, "U3 disagree");
    assert.deepEqual(disagree.writes(), [], "U3 disagree: nothing is written");

    const agree = makeWorld({
      places: [mergedInto(A, B), active(B), active(C)],
      log: [logRow("merge", C, A, T1), logRow("unmerge", C, A, T2), logRow("merge", B, A, T3)],
    });
    install(agree);
    const ok = await unmerge();
    assert.equal(ok.status, 200, `U3 agree: ${JSON.stringify(ok.body)}`);
    unchangedActive(agree, A, "U3 agree");
  });

  it("U4 a 'split' row (3812, PR #744) is not a merge record and never admits an unmerge", async () => {
    // place_merge_log admits action 'split' once 3812 is applied; the oracle has
    // no CHECK, so this models that database.
    const w = makeWorld({ places: [mergedInto(A, B), active(B)], log: [logRow("split", B, A, T1)] });
    install(w);
    refused(await unmerge(), 409, "conflict", "merge_not_logged", "U4");
    stillMerged(w, A, B, "U4");
  });

  it("U5 a log read that FAILS is answered as unavailable, never as 'not logged', and writes nothing", async () => {
    const w = makeWorld({ places: [mergedInto(A, B), active(B)], log: [logRow("merge", B, A, T1)], fail: failWhen("GET", "place_merge_log") });
    install(w);
    refused(await unmerge(), 503, "degraded_unavailable", "merge_log_unreadable", "U5");
    stillMerged(w, A, B, "U5");
    assert.deepEqual(w.writes(), [], "U5: nothing is written");
  });

  it("U6 an unmerge row that cannot be written leaves the place MERGED and answers an error, not ok", async () => {
    const w = makeWorld({ places: [mergedInto(A, B), active(B)], log: [logRow("merge", B, A, T1)], fail: failWhen("POST", "place_merge_log") });
    install(w);
    refused(await unmerge(), 500, "db_error", "unmerge_log_write_failed", "U6");
    stillMerged(w, A, B, "U6");
    assert.equal(w.log().length, 1, "U6: no new row");
    assert.ok(!w.writes().includes("PATCH places"), `U6: the place is never written — ${w.writes()}`);
  });

  it("U7 a place write that fails after the unmerge row is written withdraws that row", async () => {
    const w = makeWorld({ places: [mergedInto(A, B), active(B)], log: [logRow("merge", B, A, T1)], fail: failWhen("PATCH", "places") });
    install(w);
    refused(await unmerge(), 500, "db_error", "unmerge_write_failed", "U7");
    stillMerged(w, A, B, "U7");
    assert.deepEqual(w.log().map((x) => x.action), ["merge"], "U7: only the original merge row remains");
  });

  it("U8 when the withdrawal fails too, the answer names the orphan row", async () => {
    const w = makeWorld({
      places: [mergedInto(A, B), active(B)],
      log: [logRow("merge", B, A, T1)],
      fail: (q) => (q.method === "PATCH" && q.table === "places") || (q.method === "DELETE" && q.table === "place_merge_log") ? BROKEN : null,
    });
    install(w);
    const r = await unmerge();
    refused(r, 500, "db_error", "unmerge_log_orphaned", "U8");
    stillMerged(w, A, B, "U8");
    const orphan = w.log().find((x) => x.action === "unmerge");
    assert.ok(orphan, "U8: the orphan row is still there");
    assert.ok(String(r.body.message).includes(orphan!.id), `U8: the answer names it — ${r.body.message}`);
    assert.ok(logged.some((l) => l.level === "error" && l.line.includes(orphan!.id)), "U8: logged at error level");
  });

  it("U9 a place changed by a concurrent request is not overwritten: 409, and our row is withdrawn", async () => {
    let raced = false;
    const w = makeWorld({
      places: [mergedInto(A, B), active(B)],
      log: [logRow("merge", B, A, T1)],
      before: (q, t) => {
        if (raced || q.method === "GET" || q.method === "HEAD") return;
        raced = true; // someone else unmerged A and merged it into C just before our first write
        Object.assign(t.places!.find((p) => p.id === A)!, { merged_into_place_id: C, status: "duplicate" });
      },
    });
    install(w);
    refused(await unmerge(), 409, "conflict", "place_changed", "U9");
    stillMerged(w, A, C, "U9");
    assert.deepEqual(w.log().map((x) => x.action), ["merge"], "U9: our unmerge row is withdrawn");
  });

  it("U10 is gated by external_places_enabled: FALSE answers feature_disabled and writes nothing", async () => {
    const w = makeWorld({ places: [mergedInto(A, B), active(B)], log: [logRow("merge", B, A, T1)], flag: false });
    install(w);
    const r = await unmerge();
    assert.deepEqual([r.status, r.body?.error], [404, "feature_disabled"], JSON.stringify(r.body));
    stillMerged(w, A, B, "U10");
    assert.deepEqual(w.oracle.log.map((l) => tableOf(l.url)), ["feature_flags"], "U10: the flag is the only thing read");
  });

  it("U11 a place read that FAILS is answered as unavailable, not as 'Place not found'", async () => {
    const w = makeWorld({ places: [mergedInto(A, B), active(B)], log: [logRow("merge", B, A, T1)], fail: failWhen("GET", "places") });
    install(w);
    refused(await unmerge(), 503, "degraded_unavailable", "place_read_failed", "U11");
    assert.deepEqual(w.writes(), [], "U11: nothing is written");
  });

  it("U13 a place write that ERRORS but committed keeps the unmerge row and succeeds; an unknown outcome keeps it and says so", async () => {
    const applied = makeWorld({
      places: [mergedInto(A, B), active(B)],
      log: [logRow("merge", B, A, T1)],
      before: (q, t) => {
        if (q.method === "PATCH" && q.table === "places") Object.assign(t.places!.find((p) => p.id === A)!, { merged_into_place_id: null, status: "active" });
      },
      fail: failWhen("PATCH", "places"),
    });
    install(applied);
    const ok = await unmerge();
    assert.equal(ok.status, 200, `U13 applied: ${JSON.stringify(ok.body)}`);
    assert.deepEqual(applied.log().map((x) => x.action), ["merge", "unmerge"], "U13 applied: the unmerge row is kept");

    let patched = false;
    const unknown = makeWorld({
      places: [mergedInto(A, B), active(B)],
      log: [logRow("merge", B, A, T1)],
      before: (q) => { if (q.method === "PATCH" && q.table === "places") patched = true; },
      fail: (q) => (q.method === "PATCH" && q.table === "places") || (patched && q.method === "GET" && q.table === "places") ? BROKEN : null,
    });
    install(unknown);
    const r = await unmerge();
    refused(r, 500, "db_error", "unmerge_outcome_unknown", "U13 unknown");
    const kept = unknown.log().find((x) => x.action === "unmerge");
    assert.ok(kept && String(r.body.message).includes(kept.id), "U13 unknown: the row is kept and named");
  });

  it("U14 (X2) an applied unmerge whose response was lost, re-merged by a concurrent request before the re-read, KEEPS its row", async () => {
    let patched = false;
    let raced = false;
    const w = makeWorld({
      places: [mergedInto(A, B), active(B)],
      log: [logRow("merge", B, A, T1)],
      before: (q, t) => {
        if (q.method === "PATCH" && q.table === "places") { patched = true; Object.assign(findP(t, A), { merged_into_place_id: null, status: "active" }); return; }
        if (patched && !raced && q.method === "GET" && q.table === "places") { raced = true; concurrentMove(t, "merge", A, B); }
      },
      fail: failWhen("PATCH", "places"),
    });
    install(w);
    refused(await unmerge(), 500, "db_error", "unmerge_outcome_unknown", "U14");
    stillMerged(w, A, B, "U14");
    assert.deepEqual(w.log().map((x) => x.action), ["merge", "unmerge", "merge"], "U14: the log matches what happened");
  });

  it("U15 a re-read after a failed unmerge write that finds NO place is an unknown outcome, never 200 (V5)", async () => {
    let patched = false;
    const w = makeWorld({
      places: [mergedInto(A, B), active(B)],
      log: [logRow("merge", B, A, T1)],
      before: (q, t) => {
        if (q.method === "PATCH" && q.table === "places") { patched = true; return; }
        if (patched && q.method === "GET" && q.table === "places") t.places!.splice(t.places!.findIndex((p) => p.id === A), 1);
      },
      fail: failWhen("PATCH", "places"),
    });
    install(w);
    refused(await unmerge(), 500, "db_error", "unmerge_outcome_unknown", "U15");
    assert.deepEqual(w.log().map((x) => x.action), ["merge", "unmerge"], "U15: the row is kept");
  });

  it("U16 (X4) a merge re-made after a LOGGED unmerge without its own row is refused: the log's latest word is 'unmerge'", async () => {
    // Pre-fix residue: merged, unmerged (both logged), then merged into the same
    // survivor with a log write that silently failed.
    const w = makeWorld({ places: [mergedInto(A, B), active(B)], log: [logRow("merge", B, A, T1), logRow("unmerge", B, A, T2)] });
    install(w);
    refused(await unmerge(), 409, "conflict", "merge_not_logged", "U16");
    stillMerged(w, A, B, "U16");
    assert.deepEqual(w.writes(), [], "U16: nothing is written");
  });

  it("U12 the refusals main already had are unchanged (not found, not merged, bad id)", async () => {
    const w = makeWorld({ places: [active(A), active(B)] });
    install(w);
    const missing = await unmerge("dddddddd-dddd-4ddd-8ddd-dddddddddddd");
    assert.deepEqual([missing.status, missing.body?.error], [404, "not_found"], JSON.stringify(missing.body));
    const notMerged = await unmerge(A);
    assert.deepEqual([notMerged.status, notMerged.body?.error], [400, "invalid_payload"], JSON.stringify(notMerged.body));
    const bad = await request(base, `/api/admin/places/not-a-uuid/unmerge`);
    assert.deepEqual([bad.status, bad.body?.error], [400, "invalid_payload"], JSON.stringify(bad.body));
    assert.deepEqual(w.writes(), [], "U12: nothing is written");
  });
});

// ── ROUND TRIP ────────────────────────────────────────────────────────────────

describe("merge → unmerge → merge → unmerge over one stateful catalog", () => {
  it("R1 every change has exactly one log row, in order, and the place ends where it began", async () => {
    const w = makeWorld({ places: [active(A), active(B), active(C)] });
    install(w);
    assert.equal((await merge(A, B)).status, 200);
    assert.equal((await unmerge(A)).status, 200);
    assert.equal((await merge(A, C)).status, 200);
    assert.equal((await unmerge(A)).status, 200);
    unchangedActive(w, A, "R1");
    const rows = [...w.log()].sort((x, y) => (x.created_at < y.created_at ? -1 : 1));
    assert.deepEqual(
      rows.map((x) => `${x.action}:${x.survivor_place_id.slice(0, 4)}:${x.affected_place_id.slice(0, 4)}`),
      ["merge:bbbb:aaaa", "unmerge:bbbb:aaaa", "merge:cccc:aaaa", "unmerge:cccc:aaaa"],
    );
  });
});
