/**
 * §12 / §3.6 — a Highlight's source Memories, end to end.
 *
 * Highlights/Memories Development Architecture Spec v1:
 *   §12  "Highlights are disposable, audience-specific projections over one or
 *         more Memories or Episodes."
 *   §3.6 `highlight_sources` — "Links Highlights to Memories/Episodes"
 *   §21  a deletion has to be able to find the Highlights projecting a Memory
 *   §28.12 "Always make derived projections rebuildable"
 *
 * WHAT THE CENSUS RECORDED, AND WHICH HALF OF IT WAS STALE
 * -------------------------------------------------------
 * §O.3 moved H32 from NOT-BUILT to BUILT-BUT-WRONG when migration 2722 landed
 * on production, and stated the remaining blocker in the row itself: "Not `C`
 * on the row's own second clause, which survives: *with no TypeScript writer*.
 * `POST /highlights` still inserts a client-supplied `mediaUrl` and no
 * Highlight has a source Memory." The FIRST half of that clause is what this
 * suite closes; the second half — that a Highlight can be created with no
 * source at all — is deliberately left true, and case 6 below asserts it, so
 * H93 keeps the grade it has for the reason it has it.
 *
 * THE ASSERTION MOST WORTH HAVING is case 3. `verifyMemorySources` reads
 * `memories` to decide whether the caller owns what they are claiming, and
 * supabase-js RESOLVES on a database error — so the natural shape,
 * `(data ?? []).filter(...)`, answers "none of these are yours" for an OUTAGE.
 * Under the all-or-nothing rule that is a refusal, which is safe; under a
 * partial-link rule it would have silently stored a Highlight with no
 * provenance while telling the user it had some. The test drives the unreadable
 * table and asserts the refusal names the outage, not the ownership.
 *
 * Run: node --import tsx/esm --test src/test/highlightSourceLinks.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  startApp, call, fixtureTables, highlight, VIEWER, OWNER, H_MINE, H_PUB,
} from "./highlightsSpecHarness.js";
import {
  verifyMemorySources,
  linkHighlightSources,
  readHighlightSources,
  highlightIdsProjecting,
  MAX_HIGHLIGHT_SOURCES,
  HIGHLIGHT_SOURCE_TYPES,
  HIGHLIGHT_SOURCE_PROVENANCE,
} from "../services/highlights/highlightSources.js";
import { makeFakeClient } from "./highlightsSpecHarness.js";

const M_MINE = "40000000-0000-4000-8000-000000000001";
const M_MINE_2 = "40000000-0000-4000-8000-000000000002";
const M_THEIRS = "40000000-0000-4000-8000-000000000003";
const M_DELETED = "40000000-0000-4000-8000-000000000004";
const M_ABSENT = "40000000-0000-4000-8000-0000000000ff";

function memory(id: string, owner_id: string, state = "published") {
  return { id, owner_id, state, title: "t", visibility: "public" };
}

/** The spec fixture plus the Memories a source claim can name. */
function tablesWithMemories(): Record<string, any[]> {
  const t = fixtureTables();
  t.memories = [
    memory(M_MINE, VIEWER),
    memory(M_MINE_2, VIEWER),
    memory(M_THEIRS, OWNER),
    memory(M_DELETED, VIEWER, "deleted"),
  ];
  t.highlight_sources = [];
  return t;
}

/**
 * A client that RESOLVES a chosen `{ data, error }` for a chosen table.
 *
 * The shared fake models a store; this models a RESPONSE. Two of the guards in
 * `highlightSources.ts` — the `.error` binding and the row-count check — can
 * only be reached by a response the store fake cannot produce (an error
 * carrying an array body; an upsert that comes back short). Mutation testing
 * found both unpinned, which is the whole argument for this helper existing.
 *
 * The probe is answered `{ error: null }` so availability is READY and the
 * thing under test is the read or write that follows it.
 */
function resolving(byTable: Record<string, { data: unknown; error: unknown }>): any {
  const chain = (table: string): any => {
    let probing = false;
    const obj: any = {
      select: () => obj,
      insert: () => obj, upsert: () => obj, update: () => obj, delete: () => obj,
      in: () => obj, is: () => obj, neq: () => obj, order: () => obj, limit: () => obj,
      eq: (c: string, v: any) => {
        // `probeHighlightObject` filters on the all-zero sentinel id.
        if (c === "id" && v === "00000000-0000-0000-0000-000000000000") probing = true;
        return obj;
      },
      maybeSingle: () => settle(), single: () => settle(),
      then: (f: any, r: any) => settle().then(f, r),
    };
    async function settle() {
      if (probing) return { data: [], error: null, count: null };
      return { ...(byTable[table] ?? { data: [], error: null }), count: null };
    }
    return obj;
  };
  return { from: (t: string) => chain(t) };
}

const CREATE_BODY = {
  mediaUrl: "https://example.invalid/new.jpg",
  mediaType: "image/jpeg",
  expiresInHours: 24,
  visibility: "public",
};

/* ══════════════════════════════════════════════════════════════════════════
 * §3.6 — the writer
 * ════════════════════════════════════════════════════════════════════════*/

describe("§12 a Highlight created from Memories records what it projects", () => {
  it("POST /highlights stores one highlight_sources row per named Memory", async () => {
    const app = await startApp({ tables: tablesWithMemories() });
    try {
      const r = await call(app, "POST", "/api/highlights", VIEWER, {
        ...CREATE_BODY,
        sourceMemoryIds: [M_MINE, M_MINE_2],
      });
      assert.equal(r.status, 201);
      assert.deepEqual([...(r.body.sourceMemoryIds ?? [])].sort(), [M_MINE, M_MINE_2].sort());

      const links = app.tables.highlight_sources;
      assert.equal(links.length, 2, "one link row per source");
      for (const l of links) {
        assert.equal(l.highlight_id, r.body.id);
        assert.equal(l.source_type, "MEMORY");
        // §28.13 / §4: a link a person asserted is recorded as one.
        assert.equal(l.provenance, "USER_ASSERTED");
      }
    } finally { await app.close(); }
  });

  it("refuses a source Memory the caller does not own, and creates NO Highlight", async () => {
    const t = tablesWithMemories();
    const app = await startApp({ tables: t });
    try {
      const before = t.highlights.length;
      const r = await call(app, "POST", "/api/highlights", VIEWER, {
        ...CREATE_BODY,
        sourceMemoryIds: [M_MINE, M_THEIRS],
      });
      assert.equal(r.status, 403);
      assert.equal(t.highlights.length, before, "a refused provenance must not leave a Highlight behind");
      assert.equal(t.highlight_sources.length, 0);
    } finally { await app.close(); }
  });

  it("refuses an UNREADABLE memories table rather than storing a sourceless Highlight", async () => {
    // The whole point: `(data ?? []).filter(...)` on an outage answers "none of
    // these are yours". That must not become "link nothing and return 201".
    const t = tablesWithMemories();
    const app = await startApp({ tables: t, failTables: new Set(["memories"]) });
    try {
      const r = await call(app, "POST", "/api/highlights", VIEWER, {
        ...CREATE_BODY,
        sourceMemoryIds: [M_MINE],
      });
      assert.equal(r.status, 503, "an outage is retryable, not a permanent ownership refusal");
      assert.equal(t.highlights.length, 4, "no Highlight is created when its provenance cannot be checked");
      assert.equal(t.highlight_sources.length, 0);
    } finally { await app.close(); }
  });

  it("refuses a DELETED source Memory — a Highlight cannot project a record the owner erased", async () => {
    const t = tablesWithMemories();
    const app = await startApp({ tables: t });
    try {
      const r = await call(app, "POST", "/api/highlights", VIEWER, {
        ...CREATE_BODY,
        sourceMemoryIds: [M_DELETED],
      });
      assert.equal(r.status, 403);
      assert.equal(t.highlight_sources.length, 0);
    } finally { await app.close(); }
  });

  it("refuses when highlight_sources is NOT DEPLOYED, and creates NO Highlight at all", async () => {
    // The probe runs BEFORE the insert precisely so this case has nothing to
    // undo. A version that probed only inside the link write would create the
    // Highlight and then compensate — which works, and leaves a soft-deleted
    // row behind for a condition that was knowable first.
    const t = tablesWithMemories();
    const app = await startApp({ tables: t, absentTables: new Set(["highlight_sources"]) });
    try {
      const before = t.highlights.length;
      const r = await call(app, "POST", "/api/highlights", VIEWER, {
        ...CREATE_BODY,
        sourceMemoryIds: [M_MINE],
      });
      assert.equal(r.status, 404);
      assert.equal(r.body.error, "feature_disabled");
      assert.equal(t.highlights.length, before, "nothing was written, so there is nothing to undo");
    } finally { await app.close(); }
  });

  it("COMPENSATES a link write that fails after the Highlight row exists", async () => {
    // The one failure the pre-checks cannot remove: 2722 probes READY and the
    // insert then fails. supabase-js has no transactions, so the Highlight is
    // already there. It must not survive claiming a provenance it has not got.
    const t = tablesWithMemories();
    const app = await startApp({ tables: t, failWrites: new Set(["highlight_sources"]) });
    try {
      const before = t.highlights.length;
      const r = await call(app, "POST", "/api/highlights", VIEWER, {
        ...CREATE_BODY,
        sourceMemoryIds: [M_MINE],
      });
      assert.equal(r.status, 503, "a failed link is retryable, not a rejected request");
      assert.equal(t.highlights.length, before + 1, "the row was written before the link could fail");
      const created = t.highlights[t.highlights.length - 1];
      assert.ok(created.deleted_at, "the compensating soft-delete ran");
      assert.equal(t.highlight_sources.length, 0);
    } finally { await app.close(); }
  });

  it("a Highlight created with NO sources is still created, and is reported sourceless", async () => {
    // H93 stays BUILT-BUT-WRONG on exactly this: the create path does not
    // REQUIRE a source, so a Highlight is not yet a projection by construction.
    const t = tablesWithMemories();
    const app = await startApp({ tables: t });
    try {
      const r = await call(app, "POST", "/api/highlights", VIEWER, CREATE_BODY);
      assert.equal(r.status, 201);
      assert.deepEqual(r.body.sourceMemoryIds, []);
      assert.equal(t.highlight_sources.length, 0);
    } finally { await app.close(); }
  });
});

/* ══════════════════════════════════════════════════════════════════════════
 * §3.6 — the read, and who may make it
 * ════════════════════════════════════════════════════════════════════════*/

describe("§3.6 / §23 provenance is the owner's, not the viewer's", () => {
  it("GET /highlights/:id/sources gives the owner what the Highlight projects", async () => {
    const t = tablesWithMemories();
    t.highlight_sources.push({
      id: "l1", highlight_id: H_MINE, source_type: "MEMORY", source_id: M_MINE,
      provenance: "USER_ASSERTED", created_at: "2026-01-01T00:00:00.000Z",
    });
    const app = await startApp({ tables: t });
    try {
      const r = await call(app, "GET", `/api/highlights/${H_MINE}/sources`, VIEWER);
      assert.equal(r.status, 200);
      assert.deepEqual(r.body.sources.map((s: any) => s.sourceId), [M_MINE]);
      assert.equal(r.body.sources[0].provenance, "USER_ASSERTED");
    } finally { await app.close(); }
  });

  it("refuses a NON-OWNER with the same answer as a Highlight that is not there", async () => {
    // 2722's RLS block: "A viewer who may see the Highlight still sees the
    // Highlight; they do not learn what it was built from." H_PUB is public and
    // VIEWER can read it — and still may not read its provenance.
    const t = tablesWithMemories();
    t.highlight_sources.push({
      id: "l2", highlight_id: H_PUB, source_type: "MEMORY", source_id: M_THEIRS,
      provenance: "USER_ASSERTED", created_at: "2026-01-01T00:00:00.000Z",
    });
    const app = await startApp({ tables: t });
    try {
      const notMine = await call(app, "GET", `/api/highlights/${H_PUB}/sources`, VIEWER);
      const notThere = await call(app, "GET", `/api/highlights/30000000-0000-4000-8000-0000000000ee/sources`, VIEWER);
      assert.equal(notMine.status, 404);
      assert.deepEqual(notMine.body, notThere.body);
    } finally { await app.close(); }
  });

  it("an owner's sourceless Highlight reads as an EMPTY list, not a refusal", async () => {
    const app = await startApp({ tables: tablesWithMemories() });
    try {
      const r = await call(app, "GET", `/api/highlights/${H_MINE}/sources`, VIEWER);
      assert.equal(r.status, 200);
      assert.deepEqual(r.body.sources, []);
    } finally { await app.close(); }
  });

  it("an UNREADABLE highlight_sources refuses rather than answering 'no sources'", async () => {
    const app = await startApp({
      tables: tablesWithMemories(),
      failTables: new Set(["highlight_sources"]),
    });
    try {
      const r = await call(app, "GET", `/api/highlights/${H_MINE}/sources`, VIEWER);
      assert.equal(r.status, 503);
    } finally { await app.close(); }
  });
});

/* ══════════════════════════════════════════════════════════════════════════
 * The module, on the shapes the route cannot reach
 * ════════════════════════════════════════════════════════════════════════*/

describe("highlightSources refuses what it cannot verify", () => {
  it("declares 2722's vocabularies verbatim", () => {
    assert.deepEqual([...HIGHLIGHT_SOURCE_TYPES], ["MEMORY", "EPISODE"]);
    assert.deepEqual([...HIGHLIGHT_SOURCE_PROVENANCE], [
      "USER_ASSERTED", "SYSTEM_OBSERVED", "MUTUALLY_CONFIRMED", "INFERRED", "UNKNOWN",
    ]);
  });

  it("refuses an EPISODE source BY NAME — there is no episode id space to check it against", async () => {
    const sc = makeFakeClient(tablesWithMemories());
    const r = await linkHighlightSources(sc, {
      highlightId: H_MINE, sourceIds: [M_MINE], sourceType: "EPISODE",
    });
    assert.equal(r.ok, false);
    assert.equal((r as any).reason, "invalid");
    assert.match((r as any).detail, /memory_episodes/);
  });

  it("refuses more than MAX_HIGHLIGHT_SOURCES before it reads anything", async () => {
    const sc = makeFakeClient(tablesWithMemories());
    const many = Array.from({ length: MAX_HIGHLIGHT_SOURCES + 1 }, (_, i) =>
      `40000000-0000-4000-8000-${String(i).padStart(12, "0")}`);
    const r = await verifyMemorySources(sc, VIEWER, many);
    assert.equal(r.ok, false);
    assert.equal((r as any).reason, "invalid");
  });

  it("refuses a source id that is not a UUID", async () => {
    const sc = makeFakeClient(tablesWithMemories());
    const r = await verifyMemorySources(sc, VIEWER, ["not-a-uuid"]);
    assert.equal(r.ok, false);
    assert.equal((r as any).reason, "invalid");
  });

  it("refuses an id that names no Memory at all, as `source_not_owned`", async () => {
    const sc = makeFakeClient(tablesWithMemories());
    const r = await verifyMemorySources(sc, VIEWER, [M_ABSENT]);
    assert.equal(r.ok, false);
    assert.equal((r as any).reason, "source_not_owned");
  });

  it("is IDEMPOTENT: 2722's unique index means the same link written twice is one row", async () => {
    const t = tablesWithMemories();
    const sc = makeFakeClient(t);
    const a = await linkHighlightSources(sc, { highlightId: H_MINE, sourceIds: [M_MINE] });
    const b = await linkHighlightSources(sc, { highlightId: H_MINE, sourceIds: [M_MINE] });
    assert.equal(a.ok, true);
    assert.equal(b.ok, true);
    assert.equal(t.highlight_sources.length, 1);
  });

  it("reports a write that changed FEWER rows than it sent as write_unconfirmed", async () => {
    // An RLS-filtered write resolves `{ data: [<some rows>], error: null }`. A
    // PARTIAL link is the one outcome that must never be reported as success:
    // §21's revocation walks these rows, so a source silently dropped is a
    // deletion that will silently miss this Highlight.
    //
    // The shared fake cannot produce this — its upsert always stores what it
    // was given — so this drives the resolved value directly. A property the
    // fake cannot express is one a test using only the fake cannot pin.
    const sc = resolving({
      highlight_sources: { data: [{ highlight_id: H_MINE, source_type: "MEMORY", source_id: M_MINE, provenance: "USER_ASSERTED", created_at: null }], error: null },
    });
    const r = await linkHighlightSources(sc, { highlightId: H_MINE, sourceIds: [M_MINE, M_MINE_2] });
    assert.equal(r.ok, false);
    assert.equal((r as any).reason, "write_unconfirmed");
    assert.match((r as any).detail, /1 row\(s\) for 2 source\(s\)/);
  });

  it("an ERROR alongside an empty ARRAY still refuses — the `.error` binding is the guard, not the array shape", async () => {
    // The two guards in `verifyMemorySources` are not redundant, and a mutation
    // showed why this case needs its own test: `failTables` in the shared fake
    // resolves `{ data: null }`, so the `!Array.isArray(data)` guard catches it
    // and the `.error` branch is never the thing under test. PostgREST DOES
    // return an error with an array body, and that is the shape that would
    // otherwise read as "none of these Memories are yours" for an outage.
    const sc = resolving({ memories: { data: [], error: { message: "connection reset" } } });
    const r = await verifyMemorySources(sc, VIEWER, [M_MINE]);
    assert.equal(r.ok, false);
    assert.equal((r as any).reason, "unavailable", "an outage is not an ownership refusal");
    assert.match((r as any).detail, /memories read failed/);
  });
});

/* ══════════════════════════════════════════════════════════════════════════
 * §21 — the reverse index a deletion needs
 * ════════════════════════════════════════════════════════════════════════*/

describe("§21 which Highlights project this Memory", () => {
  it("answers with the Highlight ids, and only for MEMORY sources", async () => {
    const t = tablesWithMemories();
    t.highlights.push(highlight("30000000-0000-4000-8000-0000000000c1", VIEWER));
    t.highlight_sources.push(
      { id: "l1", highlight_id: H_MINE, source_type: "MEMORY", source_id: M_MINE, provenance: "USER_ASSERTED", created_at: null },
      { id: "l2", highlight_id: "30000000-0000-4000-8000-0000000000c1", source_type: "MEMORY", source_id: M_MINE, provenance: "USER_ASSERTED", created_at: null },
      { id: "l3", highlight_id: H_PUB, source_type: "EPISODE", source_id: M_MINE, provenance: "INFERRED", created_at: null },
    );
    const sc = makeFakeClient(t);
    const r = await highlightIdsProjecting(sc, M_MINE);
    assert.equal(r.ok, true);
    assert.deepEqual([...(r as any).value].sort(), [H_MINE, "30000000-0000-4000-8000-0000000000c1"].sort());
  });

  it("an UNREADABLE index REFUSES — 'no Highlight projects it' is the answer that lets a deletion lie", async () => {
    const sc = makeFakeClient(tablesWithMemories(), { failTables: new Set(["highlight_sources"]) });
    const r = await highlightIdsProjecting(sc, M_MINE);
    assert.equal(r.ok, false);
    assert.equal((r as any).reason, "unavailable");
  });

  it("…and refuses when the error arrives WITH an array body, which is the shape PostgREST sends", async () => {
    // Same reason as `verifyMemorySources`' sibling case: with `{ data: null }`
    // the array guard fires and the `.error` binding is untested. This is the
    // guard whose absence would let `runMemoryDeletionLifecycle` report the
    // `profile_highlight` destination reached while a Highlight went on
    // serving a deleted Memory.
    const sc = resolving({ highlight_sources: { data: [], error: { message: "connection reset" } } });
    const r = await highlightIdsProjecting(sc, M_MINE);
    assert.equal(r.ok, false);
    assert.equal((r as any).reason, "unavailable");
    assert.match((r as any).detail, /read failed/);
  });

  it("an ABSENT table is `not_deployed`, which is a different answer from unreadable", async () => {
    const sc = makeFakeClient(tablesWithMemories(), { absentTables: new Set(["highlight_sources"]) });
    const r = await readHighlightSources(sc, H_MINE);
    assert.equal(r.ok, false);
    assert.equal((r as any).reason, "not_deployed");
  });
});
