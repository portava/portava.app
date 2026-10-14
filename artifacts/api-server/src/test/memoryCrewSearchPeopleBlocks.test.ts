/**
 * memoryCrewSearchPeopleBlocks — the crew search's `row.people` honours blocks
 * between the VIEWER and a participant (census-highlights-memories §BQ).
 *
 * ── THE DEFECT (found by B58 lane MEM-POLICY, "Gaps") ────────────────────────
 * POST /memories/search with `intent: crew_trip` unions the crew's per-owner
 * `TripMemoryProjection` derivatives. Each row carries `people`: the approved
 * participants' ids, straight from `approvedTagsFor`. The derivative is SHARED —
 * built once for the crew (viewer null), never per reader — and nothing on the
 * read path consulted `blocks`. So a viewer was handed, by id, the people they
 * had blocked and the people who had blocked them; a `people` filter naming one
 * of them MATCHED; and the counts (`deterministicMatchCount`, each member's
 * `matchCount`) and the `person_relevance` dimension betrayed them even with no
 * id on the wire. §10 rule 1 (memoryParticipantVisibility.ts, `participantRungFor`)
 * is BLOCK → HIDDEN, ahead of everything, including the viewer's ownership of
 * the Memory — and GET /memories/:id and the trip recap both apply it.
 *
 * ── WHERE THE FIX LIVES, AND WHY THERE ──────────────────────────────────────
 * On the READ path (searchMemories' `withholdPeople`, called by the crew search),
 * BEFORE any filter, rank or count runs. Not in the build: a per-viewer filter
 * cannot live in a derivative that is shared across viewers, and the case below
 * that searches as a second crew member proves the shared payload is untouched.
 *
 * ── FAIL CLOSED ─────────────────────────────────────────────────────────────
 * An unreadable or THROWN block read withholds every participant but the viewer,
 * and says so (`peopleComplete: false`, `unionComplete: false`). A REAL block is
 * silent: nothing on the response differs from a participant who was never there.
 *
 * Run: node --import tsx/esm --test src/test/memoryCrewSearchPeopleBlocks.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import memoriesRouter from "../routes/memories.js";

const OWNER = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const VIEWER = "cccccccc-cccc-cccc-cccc-cccccccccccc";
const DEPARTING = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbb02";
/** The viewer blocked this person. Not crew: a participant, nothing more. */
const BLOCKED = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbb10";
/** This person blocked the viewer. */
const BLOCKER = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbb11";
/** Tagged, and blocked by nobody. */
const FRIEND = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbb12";
/** Exists, and is tagged on nothing. */
const STRANGER = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const TRIP = "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeee1";
const M_OWNER = "dddddddd-dddd-dddd-dddd-dddddddddd10";
const M_VIEWER = "dddddddd-dddd-dddd-dddd-dddddddddd11";
const M_DEPARTING = "dddddddd-dddd-dddd-dddd-dddddddddd13";
const M_TAGS_VIEWER = "dddddddd-dddd-dddd-dddd-dddddddddd14";
const M_UNTAGGED = "dddddddd-dddd-dddd-dddd-dddddddddd15";
const REG = "memory_derivative_registry";

function memory(id: string, owner: string, over: Record<string, unknown> = {}) {
  return {
    id, owner_id: owner, title: "Porto", caption: null,
    visibility: "trip_crew", allowed_user_ids: [], hidden_user_ids: [],
    trip_id: TRIP, event_id: null, place_id: null,
    location_city: "Porto", location_country: "PT",
    location_lat: null, location_lng: null, canonical_location_id: null,
    starts_at: "2026-01-02T10:00:00.000Z", ends_at: null,
    state: "published", created_at: "2026-01-02T10:00:00.000Z",
    updated_at: "2026-01-02T10:00:00.000Z",
    ...over,
  };
}

const tag = (memory_id: string, tagged_user_id: string) => ({ memory_id, tagged_user_id, status: "approved" });

function crewTables(opts: { withBlocks?: boolean } = {}): Record<string, any[]> {
  return {
    memories: [
      memory(M_OWNER, OWNER, { title: "Porto crew dinner" }),
      memory(M_VIEWER, VIEWER, { title: "Porto morning run" }),
      memory(M_DEPARTING, DEPARTING, { title: "Porto last night" }),
      memory(M_TAGS_VIEWER, OWNER, { title: "Porto bridge", starts_at: "2026-01-03T10:00:00.000Z" }),
      // Same day, same place, NO participants: the row a withheld participant must be indistinguishable from.
      memory(M_UNTAGGED, DEPARTING, { title: "Porto last night", starts_at: "2026-01-02T10:00:00.000Z" }),
    ],
    memory_items: [],
    memory_tags: [
      tag(M_OWNER, BLOCKED), tag(M_OWNER, FRIEND),
      tag(M_VIEWER, BLOCKED), tag(M_VIEWER, FRIEND), // the viewer's OWN Memory: §10 rule 1 binds its owner too
      tag(M_DEPARTING, BLOCKER),
      tag(M_TAGS_VIEWER, VIEWER), tag(M_TAGS_VIEWER, BLOCKER),
    ],
    memory_derivative_registry: [],
    profiles: [OWNER, VIEWER, DEPARTING, BLOCKED, BLOCKER, FRIEND, STRANGER].map((id) => ({
      id, account_status: "active", name: id.slice(-2), handle: id.slice(-2), avatar_url: null,
    })),
    blocks: opts.withBlocks === false ? [] : [
      { blocker_id: VIEWER, blocked_id: BLOCKED },
      { blocker_id: BLOCKER, blocked_id: VIEWER },
    ],
    feature_flags: [],
    trips: [{ id: TRIP, owner_id: OWNER }],
    trip_members: [
      { trip_id: TRIP, user_id: OWNER, role: "owner", status: "accepted" },
      { trip_id: TRIP, user_id: VIEWER, role: "member", status: "accepted" },
      { trip_id: TRIP, user_id: DEPARTING, role: "member", status: "accepted" },
    ],
  };
}

/**
 * The same table-backed double memorySearchRoute.test.ts drives the crew search
 * with (writes are applied, so a registered derivative can be read back), plus
 * two ways for ONE table's reads to fail: RESOLVED with `{ error }` the way
 * supabase-js fails (`failReads`), and REJECTED the way a torn-down client or a
 * fetch that never reached PostgREST fails (`throwReads`).
 */
function makeClient(store: Record<string, any[]>, failReads: Set<string>, throwReads: Set<string>) {
  function chain(table: string) {
    const filters: Array<(r: any) => boolean> = [];
    let single = false, isWrite = false, selectedAfterWrite = false;
    let mode: "insert" | "upsert" | "update" | "delete" | null = null;
    let payload: any = null;
    let conflict: string[] = [];
    const obj: any = {
      select(_c?: string, _o?: any) { if (isWrite) selectedAfterWrite = true; return obj; },
      insert(d: any) { isWrite = true; mode = "insert"; payload = d; return obj; },
      update(d: any) { isWrite = true; mode = "update"; payload = d; return obj; },
      upsert(d: any, o?: any) {
        isWrite = true; mode = "upsert"; payload = d;
        conflict = String(o?.onConflict ?? "id").split(",").map((c) => c.trim()).filter(Boolean);
        return obj;
      },
      delete() { isWrite = true; mode = "delete"; return obj; },
      eq(c: string, v: any) { filters.push((r) => r[c] === v); return obj; },
      neq(c: string, v: any) { filters.push((r) => r[c] !== v); return obj; },
      in(c: string, vs: any[]) { const s = new Set(vs); filters.push((r) => s.has(r[c])); return obj; },
      is(c: string, v: any) { filters.push((r) => (v === null ? r[c] == null : r[c] === v)); return obj; },
      contains(c: string, vs: any[]) { filters.push((r) => (vs as any[]).every((v) => (r[c] ?? []).includes(v))); return obj; },
      gt(c: string, v: any) { filters.push((r) => r[c] > v); return obj; },
      lt(c: string, v: any) { filters.push((r) => r[c] < v); return obj; },
      not() { return obj; }, ilike() { return obj; }, or() { return obj; }, filter() { return obj; },
      order() { return obj; }, limit() { return obj; }, range() { return obj; },
      maybeSingle() { single = true; return resolve(); },
      single() { single = true; return resolve(); },
      then(f: any, r: any) { return resolve().then(f, r); },
    };
    async function resolve(): Promise<any> {
      if (!isWrite && throwReads.has(table)) throw new Error(`fetch failed (${table})`);
      if (!isWrite && failReads.has(table)) return { data: null, error: { message: `${table} unavailable` }, count: null };
      const all = (store[table] ??= []);
      if (mode === "insert" || mode === "upsert") {
        const rows = (Array.isArray(payload) ? payload : [payload]).map((r: any) => ({ ...r }));
        const out: any[] = [];
        for (const r of rows) {
          const existing = mode === "upsert" && conflict.length
            ? all.find((e: any) => conflict.every((c) => e[c] === r[c]))
            : undefined;
          if (existing) { Object.assign(existing, r); out.push(existing); }
          else { const stored = { ...r, id: r.id ?? `new-${all.length}-${table}` }; all.push(stored); out.push(stored); }
        }
        return { data: single ? out[0] : out, error: null, count: out.length };
      }
      const matched = all.filter((r) => filters.every((f) => f(r)));
      if (mode === "delete") {
        const gone = new Set(matched);
        store[table] = all.filter((r) => !gone.has(r));
        return selectedAfterWrite ? { data: matched, error: null, count: matched.length } : { data: null, error: null, count: null };
      }
      if (mode === "update") {
        for (const r of matched) Object.assign(r, payload);
        return selectedAfterWrite ? { data: matched, error: null, count: matched.length } : { data: null, error: null, count: null };
      }
      if (single) return { data: matched[0] ?? null, error: null, count: null };
      return { data: matched, error: null, count: null };
    }
    return obj;
  }
  return {
    from(table: string) { return chain(table); },
    rpc: async () => ({ data: null, error: { message: "no rpc" } }),
    auth: { getUser: async (token: string) => ({ data: { user: { id: token } }, error: null }) },
  };
}

interface App { baseUrl: string; store: Record<string, any[]>; close: () => Promise<void> }

async function startApp(opts: { store?: Record<string, any[]>; failReads?: Set<string>; throwReads?: Set<string> } = {}): Promise<App> {
  const store = opts.store ?? crewTables();
  _setTestClient(makeClient(store, opts.failReads ?? new Set(), opts.throwReads ?? new Set()) as any, true);
  const app = express();
  app.use(express.json());
  app.use((req: any, _r: any, n: any) => { req.log = { error: () => {}, info: () => {}, warn: () => {} }; n(); });
  app.use("/api", memoriesRouter);
  return new Promise((resolve, reject) => {
    const srv = http.createServer(app);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address() as { port: number };
      srv.unref();
      resolve({
        baseUrl: `http://127.0.0.1:${port}`, store,
        close: () => new Promise<void>((r) => { srv.closeAllConnections(); srv.close(() => r()); }),
      });
    });
    srv.on("error", reject);
  });
}

async function crewSearch(app: App, actor: string, extra: Record<string, unknown> = {}) {
  const res = await fetch(app.baseUrl + "/api/memories/search", {
    method: "POST",
    headers: { Authorization: `Bearer ${actor}`, "Content-Type": "application/json", connection: "close" },
    body: JSON.stringify({ intent: { kind: "crew_trip", tripId: TRIP }, ...extra }),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

const hitIds = (b: any) => ((b?.hits ?? []) as any[]).map((h) => h.memoryId).sort();
const peopleOf = (b: any, memoryId: string): string[] =>
  [...((((b?.hits ?? []) as any[]).find((h) => h.memoryId === memoryId)?.row?.people ?? []) as string[])].sort();
const everyoneNamed = (b: any) => new Set(((b?.hits ?? []) as any[]).flatMap((h) => (h.row?.people ?? []) as string[]));
const matchCounts = (b: any) => Object.fromEntries(((b?.members ?? []) as any[]).map((m) => [m.memberId, m.matchCount]));
/** Everything on a crew-search answer except the hits' rows: what a filter selected, and how it was counted. */
const shape = (b: any) => ({
  hits: hitIds(b),
  deterministicMatchCount: b.deterministicMatchCount,
  matchCounts: matchCounts(b),
  unionComplete: b.unionComplete,
  peopleComplete: b.peopleComplete,
  audienceWithheldCount: b.audienceWithheldCount,
  withheldMembers: b.withheldMembers,
});

describe("§BQ the crew search's people honour blocks between the viewer and a participant", () => {
  it("CONTROL: with no block, the fixture names every participant and a people filter matches them", async () => {
    const app = await startApp({ store: crewTables({ withBlocks: false }) });
    try {
      const r = await crewSearch(app, VIEWER);
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.deepEqual(peopleOf(r.body, M_OWNER), [BLOCKED, FRIEND].sort());
      assert.deepEqual(peopleOf(r.body, M_DEPARTING), [BLOCKER]);
      assert.deepEqual(peopleOf(r.body, M_VIEWER), [BLOCKED, FRIEND].sort());
      const f = await crewSearch(app, VIEWER, { people: [BLOCKER] });
      assert.deepEqual(hitIds(f.body), [M_DEPARTING, M_TAGS_VIEWER].sort(), "a people filter CAN match this person");
      assert.equal(r.body.unionComplete, true);
    } finally { await app.close(); }
  });

  it("a person the viewer blocked, and a person who blocked the viewer, are named on NO row — the viewer's own Memory included", async () => {
    const app = await startApp();
    try {
      const r = await crewSearch(app, VIEWER);
      assert.equal(r.status, 200, JSON.stringify(r.body));
      const named = everyoneNamed(r.body);
      assert.ok(!named.has(BLOCKED), "the person the viewer blocked was named");
      assert.ok(!named.has(BLOCKER), "the person who blocked the viewer was named");
      assert.deepEqual(peopleOf(r.body, M_OWNER), [FRIEND], "another member's Memory: only the unblocked participant");
      assert.deepEqual(peopleOf(r.body, M_VIEWER), [FRIEND], "§10 rule 1 binds the Memory's owner too: the viewer's own slice drops the block");
      assert.deepEqual(peopleOf(r.body, M_DEPARTING), []);
      assert.deepEqual(peopleOf(r.body, M_TAGS_VIEWER), [VIEWER], "the viewer is never withheld from themselves");
      // Every Memory is still served: a block withholds a PERSON, not the Memory they were tagged on.
      assert.deepEqual(hitIds(r.body), [M_DEPARTING, M_OWNER, M_TAGS_VIEWER, M_UNTAGGED, M_VIEWER].sort());
    } finally { await app.close(); }
  });

  it("a REAL block is silent: the answer's completeness and counts are exactly those of the no-block answer", async () => {
    const free = await startApp({ store: crewTables({ withBlocks: false }) });
    const blocked = await startApp();
    try {
      const a = await crewSearch(free, VIEWER);
      const b = await crewSearch(blocked, VIEWER);
      assert.deepEqual(shape(b.body), shape(a.body));
      assert.equal(b.body.peopleComplete, true, "a block is never announced");
      assert.equal(b.body.unionComplete, true);
    } finally { await free.close(); await blocked.close(); }
  });

  it("a people filter naming a blocked person matches NOTHING, and every count is a never-tagged stranger's", async () => {
    const app = await startApp();
    try {
      for (const p of [BLOCKER, BLOCKED]) {
        const r = await crewSearch(app, VIEWER, { people: [p] });
        const s = await crewSearch(app, VIEWER, { people: [STRANGER] });
        assert.equal(r.status, 200, JSON.stringify(r.body));
        assert.deepEqual(hitIds(r.body), [], `a filter on ${p} matched`);
        assert.equal(r.body.deterministicMatchCount, 0);
        for (const [member, n] of Object.entries(matchCounts(r.body))) assert.equal(n, 0, `member ${member}'s count betrays ${p}`);
        assert.deepEqual(shape(r.body), shape(s.body), "indistinguishable from a person who was never there");
      }
      // AND semantics: a blocked person in a two-person filter empties it, exactly as a stranger would.
      const pair = await crewSearch(app, VIEWER, { people: [FRIEND, BLOCKED] });
      const pairStranger = await crewSearch(app, VIEWER, { people: [FRIEND, STRANGER] });
      assert.deepEqual(shape(pair.body), shape(pairStranger.body));
      assert.deepEqual(hitIds(pair.body), []);
      // CONTROL inside the case: the unblocked participant IS matchable.
      assert.deepEqual(hitIds((await crewSearch(app, VIEWER, { people: [FRIEND] })).body), [M_OWNER, M_VIEWER].sort());
    } finally { await app.close(); }
  });

  it("the ranking does not betray a withheld participant: a row whose only person is blocked ranks as an untagged row", async () => {
    const app = await startApp();
    try {
      const r = await crewSearch(app, VIEWER);
      const hit = (id: string) => (r.body.hits as any[]).find((h) => h.memoryId === id);
      assert.equal(hit(M_DEPARTING).dimensions.person_relevance, 0, "0.5 says somebody is tagged here");
      assert.deepEqual(hit(M_DEPARTING).dimensions, hit(M_UNTAGGED).dimensions);
      assert.equal(hit(M_DEPARTING).score, hit(M_UNTAGGED).score);
    } finally { await app.close(); }
  });

  it("the SHARED derivative is not narrowed for one viewer: it still names the person, and another crew member still sees them", async () => {
    const app = await startApp();
    try {
      await crewSearch(app, VIEWER);
      const ownerReg = app.store[REG].find((g: any) => g.projection_id === "TripMemoryProjection" && g.owner_id === OWNER && g.viewer_id == null);
      assert.ok(ownerReg, "the owner's shared crew derivative was registered");
      const row = (ownerReg.payload_json as any[]).find((x) => x.memory_id === M_OWNER);
      assert.deepEqual([...row.people].sort(), [BLOCKED, FRIEND].sort(), "the build is shared; the narrowing is per read");
      const other = await crewSearch(app, DEPARTING);
      assert.equal(other.status, 200, JSON.stringify(other.body));
      assert.deepEqual(peopleOf(other.body, M_OWNER), [BLOCKED, FRIEND].sort(), "a crew member with no block still sees both");
    } finally { await app.close(); }
  });
});

describe("§BQ an unreadable block state withholds every participant but the viewer, and says so", () => {
  for (const [label, opts] of [
    ["RESOLVED with an error", { failReads: new Set(["blocks"]) }],
    ["THROWN (the read rejected)", { throwReads: new Set(["blocks"]) }],
  ] as const) {
    it(`the blocks read ${label}: the Memories are served, their people are not, and the answer is marked incomplete`, async () => {
      const app = await startApp({ store: crewTables({ withBlocks: false }), ...opts });
      try {
        const r = await crewSearch(app, VIEWER);
        assert.equal(r.status, 200, JSON.stringify(r.body));
        assert.deepEqual(hitIds(r.body), [M_DEPARTING, M_OWNER, M_TAGS_VIEWER, M_UNTAGGED, M_VIEWER].sort(), "a person's block state is not the Memory's");
        assert.deepEqual([...everyoneNamed(r.body)], [VIEWER], "nobody but the viewer may be named while blocks are unknown");
        assert.equal(r.body.peopleComplete, false);
        assert.equal(r.body.unionComplete, false, "a partial answer never presents as complete");
        assert.deepEqual(r.body.withheldMembers, [], "no MEMBER was withheld — the gap is the people");
        const f = await crewSearch(app, VIEWER, { people: [FRIEND] });
        assert.deepEqual(hitIds(f.body), [], "a people filter cannot match a person whose block state is unknown");
        assert.equal(f.body.peopleComplete, false, "and the empty answer says why it may be empty");
      } finally { await app.close(); }
    });
  }

  it("CONTROL: a crew whose Memories name nobody but the viewer needs no block read, and stays complete when blocks is unreadable", async () => {
    const store = crewTables({ withBlocks: false });
    store.memory_tags = [tag(M_TAGS_VIEWER, VIEWER)];
    const app = await startApp({ store, failReads: new Set(["blocks"]) });
    try {
      const r = await crewSearch(app, VIEWER);
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal(r.body.peopleComplete, true);
      assert.equal(r.body.unionComplete, true);
      assert.deepEqual(peopleOf(r.body, M_TAGS_VIEWER), [VIEWER]);
    } finally { await app.close(); }
  });
});
