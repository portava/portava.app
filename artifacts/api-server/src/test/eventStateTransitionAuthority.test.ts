/**
 * `events.state` has ONE authority, and every writer goes through it.
 *
 * ── THE DEFECT ───────────────────────────────────────────────────────────────
 * Nine sites in routes/events.ts wrote `events.state`. Eight carried their own
 * hand-rolled opinion about what was legal; `PATCH /events/:id` carried none:
 *
 *     state: z.enum(["draft","open","started","completed","cancelled","archived"]).optional()
 *     if (b.state !== undefined) patch.state = b.state;     // ← written raw
 *
 * guarded only by `role === "host"`. So the host of an event could:
 *   • PATCH {state:"completed"} from `draft`, skipping POST /complete's
 *     `state === "started"` precondition entirely;
 *   • PATCH {state:"open"} over `cancelled`, un-cancelling an event whose
 *     attendees had already been pushed "Event cancelled";
 *   • PATCH {state:"started"} — writing by hand the one value that the flag
 *     `event_start_transition_enabled` (seeded FALSE, migration 2600) exists to
 *     withhold until the EVENT_START_TRANSITION owner decision is taken. The
 *     flag gated the scheduler and nothing else, so it was not a gate: any host
 *     could unlock the complete / attendance / no-show routes and the trust
 *     awards behind them today.
 * And `POST /events/:id/archive` read no state at all and DISCARDED its
 * UPDATE's `.error` — supabase-js RESOLVES on a database error — so a refused
 * archive answered `{ ok: true }`.
 *
 * ── WHAT IS PROVEN HERE ──────────────────────────────────────────────────────
 *   A. The table itself: total over the state enum, no self-loops, `archived`
 *      terminal, and the specific pairs the routes depend on.
 *   B. STRUCTURAL — routes/events.ts contains no raw `events.state` UPDATE at
 *      all. The scan counts the sites it inspected and FAILS on zero, so it
 *      cannot pass by matching nothing; and it fails if a tenth writer is added
 *      without going through the helper.
 *   C. BEHAVIOURAL — over a real express server, with the `req.log` shim (a
 *      missing shim makes these routes CRASH and a 500-from-crash would
 *      masquerade as a refusal). Every refusal asserts the CODE in the envelope,
 *      not merely `status !== 200`: a request rejected at validation never
 *      reaches the gate and would satisfy the looser assertion.
 *      Each refusal has its HEALTHY TWIN — a "refuse everything" implementation
 *      would pass every refusal case here and break the whole lifecycle.
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx/esm --test src/test/eventStateTransitionAuthority.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createServer, type Server } from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import eventsRouter from "../routes/events.js";
import {
  EVENT_STATES,
  EVENT_STATE_TRANSITIONS,
  EVENT_STARTABLE_STATES,
  EVENT_STARTED_STATE,
  decideEventTransition,
  eventStatesAllowedBefore,
  isEventStartTransition,
  type EventState,
} from "../lib/eventLifecycle.js";

const ROUTES_SRC = fileURLToPath(new URL("../routes/events.ts", import.meta.url));

// ══════════════════════════════════════════════════════════════════════════════
// A. The table
// ══════════════════════════════════════════════════════════════════════════════

describe("EVENT_STATE_TRANSITIONS — the table", () => {
  it("is total over the state enum, in both directions", () => {
    // Vacuity guard: the enum itself must be the eight-value one the database
    // has. A shrunken enum would make every case below trivially true.
    assert.deepEqual([...EVENT_STATES].sort(), [
      "archived", "cancelled", "completed", "draft", "full", "open", "started", "waitlist",
    ]);
    for (const s of EVENT_STATES) {
      assert.ok(Array.isArray(EVENT_STATE_TRANSITIONS[s]), `${s} has no entry`);
      for (const t of EVENT_STATE_TRANSITIONS[s]) {
        assert.ok((EVENT_STATES as readonly string[]).includes(t), `${s} -> ${t}: ${t} is not a state`);
      }
    }
  });

  it("has no self-loop, and refuses one at the decision boundary", () => {
    for (const s of EVENT_STATES) {
      assert.ok(!EVENT_STATE_TRANSITIONS[s].includes(s), `${s} lists itself`);
      const d = decideEventTransition(s, s);
      assert.equal(d.allowed, false);
      assert.equal((d as any).reason, "same_state");
    }
  });

  it("archived is terminal and reachable from every other state", () => {
    assert.deepEqual(EVENT_STATE_TRANSITIONS.archived, []);
    for (const s of EVENT_STATES) {
      if (s === "archived") continue;
      assert.ok(EVENT_STATE_TRANSITIONS[s].includes("archived"), `${s} cannot be archived`);
    }
  });

  it("pins the pairs the routes depend on — and the ones they must refuse", () => {
    const legal: Array<[EventState, EventState]> = [
      ["draft", "open"],        // POST /events/:id/publish
      ["open", "full"],         // syncEventState, capacity reached
      ["open", "waitlist"],     // syncEventState, capacity reached with a waitlist
      ["full", "open"],         // syncEventState, a seat freed
      ["open", "started"],      // runEventStartPass
      ["full", "started"],
      ["waitlist", "started"],
      ["started", "completed"], // POST /events/:id/complete
      ["open", "draft"],        // POST /events/:id/postpone
      ["open", "cancelled"],    // POST /events/:id/cancel, DELETE /events/:id
      ["cancelled", "archived"],
      ["completed", "archived"],
    ];
    for (const [f, t] of legal) {
      assert.equal(decideEventTransition(f, t).allowed, true, `${f} -> ${t} must be legal`);
    }

    const illegal: Array<[EventState, EventState]> = [
      ["draft", "started"],      // an unpublished event cannot be in progress
      ["draft", "completed"],    // the PATCH bypass of POST /complete
      ["open", "completed"],     // complete requires `started`
      ["cancelled", "open"],     // un-cancelling
      ["cancelled", "draft"],
      ["completed", "open"],     // un-completing
      ["completed", "started"],  // re-running an event to farm its awards
      ["completed", "cancelled"],// cancelling something that already happened
      ["archived", "open"],      // archived is terminal
      ["archived", "cancelled"],
      ["started", "open"],       // would re-run the start transition
    ];
    for (const [f, t] of illegal) {
      const d = decideEventTransition(f, t);
      assert.equal(d.allowed, false, `${f} -> ${t} must be refused`);
      assert.equal((d as any).reason, "illegal_transition");
    }
  });

  it("refuses unknown states rather than passing them through", () => {
    assert.equal((decideEventTransition("banana", "open") as any).reason, "unknown_from_state");
    assert.equal((decideEventTransition("open", "banana") as any).reason, "unknown_to_state");
    assert.equal((decideEventTransition(null, undefined) as any).allowed, false);
    assert.equal((decideEventTransition(7, {}) as any).allowed, false);
  });

  it("EVENT_STARTABLE_STATES is derived from the table, not restated beside it", () => {
    assert.deepEqual([...EVENT_STARTABLE_STATES].sort(), ["full", "open", "waitlist"]);
    // The derivation: exactly the states the table lets become `started`.
    for (const s of EVENT_STATES) {
      const inSet = EVENT_STARTABLE_STATES.includes(s);
      const inTable = s !== EVENT_STARTED_STATE && EVENT_STATE_TRANSITIONS[s].includes(EVENT_STARTED_STATE);
      assert.equal(inSet, inTable, `${s}: startable set and table disagree`);
    }
  });

  it("eventStatesAllowedBefore inverts the table exactly", () => {
    for (const t of EVENT_STATES) {
      const before = eventStatesAllowedBefore(t);
      for (const f of EVENT_STATES) {
        assert.equal(
          before.includes(f),
          f !== t && EVENT_STATE_TRANSITIONS[f].includes(t),
          `${f} -> ${t} inversion disagrees`,
        );
      }
    }
    assert.deepEqual([...eventStatesAllowedBefore("started")].sort(), ["full", "open", "waitlist"]);
    assert.deepEqual([...eventStatesAllowedBefore("completed")], ["started"]);
  });

  it("names the start transition — the pair whose TRIGGER is undecided", () => {
    assert.equal(isEventStartTransition("open", "started"), true);
    assert.equal(isEventStartTransition("draft", "started"), true);
    assert.equal(isEventStartTransition("open", "completed"), false);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// B. Structural — no route writes `events.state` outside the authority
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Comments are stripped before every scan below. Without that, a line of PROSE
 * quoting the defect ("it used to be `patch.state = b.state`") satisfies the
 * regex looking for the defect, and the check passes for the wrong reason —
 * or, worse, fails on a file that is correct.
 */
function stripComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .split("\n")
    .map((l) => {
      const i = l.indexOf("//");
      return i < 0 ? l : l.slice(0, i);
    })
    .join("\n");
}

/** The balanced `.update({ … })` argument of a chain, or null if there is none. */
function updateArg(chain: string): string | null {
  const i = chain.indexOf(".update(");
  if (i < 0) return null;
  let depth = 0;
  for (let k = i + ".update(".length - 1; k < chain.length; k++) {
    const ch = chain[k];
    if (ch === "(" || ch === "{") depth++;
    else if (ch === ")" || ch === "}") {
      depth--;
      if (depth === 0) return chain.slice(i, k + 1);
    }
  }
  return null;
}

describe("routes/events.ts — every events.state write goes through the authority", () => {
  const src = stripComments(readFileSync(ROUTES_SRC, "utf8"));

  it("the source is the real one (vacuity guard)", () => {
    assert.ok(src.length > 100_000, "routes/events.ts did not load");
    assert.ok(src.includes('router.patch("/events/:id"'), "the PATCH route is not in this file");
  });

  it("contains no raw `.from(\"events\").update({ … state: … })` outside writeEventState", () => {
    // Every `.from("events")` chain, with the 400 characters that follow it —
    // enough to cover the whole builder chain and its patch object.
    const chains: string[] = [];
    const re = /\.from\(\s*"events"\s*\)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src)) !== null) chains.push(src.slice(m.index, m.index + 400));
    // Vacuity guard: a scan that inspected nothing must FAIL, not pass.
    assert.ok(chains.length >= 10, `expected many events chains, inspected ${chains.length}`);

    const stateWrites = chains.filter((c) => {
      const arg = updateArg(c);
      // Brace-balanced, so the scan sees the patch object and nothing after it.
      // A fixed-width window bled into the NEXT statement and reported an
      // innocent `.update({ going_count })` as a state write.
      return arg !== null && /\bstate\s*:/.test(arg);
    });

    // Exactly one survives: the helper itself.
    assert.equal(
      stateWrites.length, 1,
      `every events.state UPDATE must be writeEventState's; found ${stateWrites.length}:\n` +
        stateWrites.map((c) => c.slice(0, 160)).join("\n---\n"),
    );
    assert.ok(
      stateWrites[0]!.includes("state: to,"),
      "the surviving state UPDATE is not writeEventState's parameterised one",
    );
  });

  it("writeEventState asks the authority, writes conditionally, and checks both failure shapes", () => {
    const i = src.indexOf("async function writeEventState(");
    assert.ok(i > 0, "writeEventState is gone — the routes have no single writer");
    const body = src.slice(i, i + 1800);
    assert.ok(body.includes("decideEventTransition("), "writeEventState does not consult the authority");
    assert.ok(/\.eq\(\s*"state",\s*decision\.from\s*\)/.test(body),
      "the UPDATE is not conditional on the state that was decided on");
    assert.ok(body.includes('.select("id")'), "no .select() — a zero-row write would look like success");
    assert.ok(body.includes("if (error)"), "the UPDATE's .error is not checked");
    assert.ok(body.includes("data.length === 0"), "a zero-row write is not distinguished from a written one");
  });

  it("PATCH /events/:id no longer assembles `state` into the raw patch", () => {
    assert.ok(!/patch\.state\s*=/.test(src), "PATCH still writes state raw");
    const i = src.indexOf('router.patch("/events/:id"');
    const body = src.slice(i, i + 6000);
    assert.ok(body.includes("isEventStartTransition("), "PATCH does not refuse the start transition by name");
    assert.ok(body.includes("writeEventState("), "PATCH does not go through the single writer");
  });

  it("POST /events/:id/archive reads the current state before writing it", () => {
    const i = src.indexOf('router.post("/events/:id/archive"');
    assert.ok(i > 0);
    const body = src.slice(i, i + 1800);
    assert.ok(body.includes("writeEventState("), "archive still writes state directly");
    assert.ok(/select\(\s*"state"\s*\)/.test(body), "archive still writes without reading the current state");
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// C. Behavioural — over the real router
// ══════════════════════════════════════════════════════════════════════════════

const HOST  = "aaaaaaaa-9999-4000-a000-000000000001";
const EVENT = "bbbbbbbb-9999-4000-a000-000000000002";
const TOK   = "tok-host";

type Rows = Record<string, any[]>;

/**
 * Table-driven fake. `failTables` answers `{ data: null, error }` — the RESOLVED
 * failure supabase-js really produces, never a throw. UPDATEs mutate the backing
 * rows and honour the `.eq()` filters, so a CONDITIONAL update that matches
 * nothing returns `[]` exactly as postgrest would; without that, the contention
 * case below could not be distinguished from a successful write.
 */
function makeClient(
  rows: Rows,
  failTables: ReadonlySet<string> = new Set(),
  writes?: any[],
  failWrites: ReadonlySet<string> = new Set(),
) {
  function chain(table: string) {
    const filters: Array<(r: any) => boolean> = [];
    let patch: any = null;
    let inserted: any = null;
    function matched() {
      return (rows[table] ?? []).filter((r) => filters.every((f) => f(r)));
    }
    function settle(single: boolean) {
      if (failTables.has(table)) {
        return Promise.resolve({ data: null, error: { message: `${table} write failed`, code: "57014" }, count: null });
      }
      if (patch !== null) {
        if (failWrites.has(table)) {
          return Promise.resolve({ data: null, error: { message: `${table} update failed`, code: "57014" }, count: null });
        }
        const hit = matched();
        writes?.push({ table, patch, matched: hit.length });
        for (const r of hit) Object.assign(r, patch);
        return Promise.resolve({ data: single ? (hit[0] ?? null) : hit, error: null, count: hit.length });
      }
      if (inserted) {
        const row = { id: `${table}-inserted`, ...inserted };
        (rows[table] ??= []).push(row);
        return Promise.resolve({ data: single ? row : [row], error: null, count: 1 });
      }
      const out = matched();
      return Promise.resolve({ data: single ? (out[0] ?? null) : out, error: null, count: out.length });
    }
    const b: any = {
      select() { return b; },
      eq(c: string, v: any)  { filters.push((r) => r[c] === v); return b; },
      neq(c: string, v: any) { filters.push((r) => r[c] !== v); return b; },
      in(c: string, v: any[]) { filters.push((r) => v.includes(r[c])); return b; },
      is(c: string, v: any)  { filters.push((r) => (r[c] ?? null) === v); return b; },
      not() { return b; }, gt() { return b; }, gte() { return b; }, lte() { return b; }, lt() { return b; },
      ilike() { return b; }, contains() { return b; }, overlaps() { return b; }, or() { return b; },
      order() { return b; }, range() { return b; }, limit() { return b; },
      insert(p: any) { inserted = Array.isArray(p) ? p[0] : p; return b; },
      upsert(p: any) { inserted = Array.isArray(p) ? p[0] : p; return b; },
      update(p: any) { patch = p; return b; },
      delete() { return b; },
      maybeSingle() { return settle(true); },
      single() { return settle(true); },
      then(f: any, j: any) { return settle(false).then(f, j); },
    };
    return b;
  }
  return {
    from: (t: string) => chain(t),
    rpc: () => Promise.resolve({ data: null, error: null }),
    auth: {
      getUser: async (tok: string) =>
        tok === TOK
          ? { data: { user: { id: HOST } }, error: null }
          : { data: { user: null }, error: { message: "bad token" } },
    },
  };
}

function baseRows(state: string): Rows {
  return {
    feature_flags: [{ flag: "events_enabled", enabled: true }],
    events: [{
      id: EVENT, host_id: HOST, state, visibility: "public", title: "Rooftop set",
      description: "d", location_name: "The Roof", chat_enabled: false,
      starts_at: new Date(Date.now() + 86_400_000).toISOString(), ends_at: null,
      max_attendees: null, waitlist_enabled: false, rsvp_closed: false,
    }],
    event_roles: [{ event_id: EVENT, user_id: HOST, role: "host" }],
    event_rsvps: [], event_attendees: [], event_waitlist: [], event_attendee_states: [],
    event_join_requests: [], event_activity_log: [], profiles: [], blocks: [],
    notifications: [], message_threads: [], trust_events: [], trust_profiles: [],
  };
}

let server: Server;
let base = "";

before(async () => {
  const app = express();
  app.use(express.json());
  // Without this shim these routes CRASH on req.log and a 500-from-crash would
  // be indistinguishable from a deliberate refusal.
  app.use((req: any, _res, next) => {
    req.log = { info() {}, warn() {}, error() {}, debug() {} };
    next();
  });
  app.use(eventsRouter);
  server = createServer(app);
  // 127.0.0.1 explicitly: a host-less listen(0) binds the IPv6 wildcard and the
  // kernel may hand back a loopback port a foreign process already holds. The
  // address makes the bind deferred, so the callback is when address() is readable.
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as any).port}`;
});

after(async () => {
  _setTestClient(null as any, false);
  _setTestServiceClient(null as any);
  await new Promise<void>((r) => server.close(() => r()));
});

function install(
  rows: Rows,
  fail: ReadonlySet<string> = new Set(),
  writes?: any[],
  failWrites: ReadonlySet<string> = new Set(),
) {
  const c = makeClient(rows, fail, writes, failWrites);
  _setTestClient(c as any, true);
  _setTestServiceClient(c as any);
  return c;
}

async function call(method: string, path: string, body?: any) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { authorization: `Bearer ${TOK}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const json: any = await res.json().catch(() => ({}));
  return { status: res.status, body: json };
}

describe("PATCH /events/:id — the free transition is closed", () => {
  it("REFUSES {state:'started'} — the flag, not a PATCH, decides that", async () => {
    const rows = baseRows("open");
    await install(rows);
    const { status, body } = await call("PATCH", `/events/${EVENT}`, { state: "started" });
    // The CODE, not merely a non-200: a body rejected at validation would also
    // be non-200 and would prove nothing about the gate.
    assert.equal(body?.error, "invalid_state_transition", JSON.stringify(body));
    assert.equal(status, 409);
    assert.match(String(body?.message), /event_start_transition_enabled/);
    // And the row is untouched — the refusal is not merely cosmetic.
    assert.equal(rows.events[0]!.state, "open");
  });

  it("REFUSES {state:'completed'} from draft — POST /complete requires `started`", async () => {
    const rows = baseRows("draft");
    await install(rows);
    const { status, body } = await call("PATCH", `/events/${EVENT}`, { state: "completed" });
    assert.equal(body?.error, "invalid_state_transition", JSON.stringify(body));
    assert.equal(status, 409);
    assert.equal(rows.events[0]!.state, "draft");
  });

  it("REFUSES {state:'open'} over a cancelled event — no silent un-cancelling", async () => {
    const rows = baseRows("cancelled");
    await install(rows);
    const { status, body } = await call("PATCH", `/events/${EVENT}`, { state: "open" });
    assert.equal(body?.error, "invalid_state_transition", JSON.stringify(body));
    assert.equal(status, 409);
    assert.equal(rows.events[0]!.state, "cancelled");
  });

  it("STILL ALLOWS the legal draft -> open, and the row really moves", async () => {
    // The healthy twin. A gate that refused everything would pass all three
    // cases above and make the event lifecycle unusable.
    const rows = baseRows("draft");
    await install(rows);
    const { status } = await call("PATCH", `/events/${EVENT}`, { state: "open" });
    assert.equal(status, 200);
    assert.equal(rows.events[0]!.state, "open", "the legal transition must actually be written");
  });

  it("STILL ALLOWS an ordinary edit that does not touch state", async () => {
    const rows = baseRows("open");
    await install(rows);
    const { status } = await call("PATCH", `/events/${EVENT}`, { title: "Renamed" });
    assert.equal(status, 200);
    assert.equal(rows.events[0]!.title, "Renamed");
    assert.equal(rows.events[0]!.state, "open");
  });

  it("a no-op {state:<current>} is not an error", async () => {
    const rows = baseRows("open");
    await install(rows);
    const { status } = await call("PATCH", `/events/${EVENT}`, { state: "open" });
    assert.equal(status, 200);
    assert.equal(rows.events[0]!.state, "open");
  });
});

describe("POST /events/:id/archive — reads first, and reports a refused write", () => {
  it("archives a cancelled event (legal) and the row moves", async () => {
    const rows = baseRows("cancelled");
    await install(rows);
    const { status, body } = await call("POST", `/events/${EVENT}/archive`);
    assert.equal(status, 200, JSON.stringify(body));
    assert.equal(rows.events[0]!.state, "archived");
  });

  it("is idempotent on an already-archived event, and writes nothing", async () => {
    const rows = baseRows("archived");
    const writes: any[] = [];
    await install(rows, new Set(), writes);
    const { status } = await call("POST", `/events/${EVENT}/archive`);
    assert.equal(status, 200);
    assert.equal(
      writes.filter((w) => w.table === "events" && "state" in w.patch).length, 0,
      "a second archive must not re-write the state",
    );
  });

  it("REFUSES with db_error when the UPDATE errors (was: {ok:true})", async () => {
    // supabase-js RESOLVES on a database error. This route discarded `.error`
    // entirely and told the host the event was archived when it was not.
    // Only the WRITE fails here: the reads all succeed, so the route reaches
    // the UPDATE and the refusal can only come from the checked `.error`.
    const rows = baseRows("open");
    await install(rows, new Set(), undefined, new Set(["events"]));
    const { status, body } = await call("POST", `/events/${EVENT}/archive`);
    assert.equal(body?.error, "db_error", JSON.stringify(body));
    assert.equal(status, 500);
    assert.notEqual(body?.ok, true);
    assert.equal(rows.events[0]!.state, "open", "the row must not have moved");
  });

  it("refuses an event that does not exist instead of reporting a phantom archive", async () => {
    // getEventRole answers null for a missing event, so the refusal is
    // `forbidden` rather than `not_found` — it must still not be ok:true.
    const rows = baseRows("open");
    rows.events = [];
    await install(rows);
    const { status, body } = await call("POST", `/events/${EVENT}/archive`);
    assert.equal(body?.error, "forbidden", JSON.stringify(body));
    assert.equal(status, 403);
    assert.notEqual(body?.ok, true);
  });
});

describe("POST /events/:id/complete — the precondition is now the table's", () => {
  it("REFUSES an open event with the transition code", async () => {
    const rows = baseRows("open");
    await install(rows);
    const { status, body } = await call("POST", `/events/${EVENT}/complete`);
    assert.notEqual(status, 200);
    assert.ok(
      body?.error === "invalid_payload" || body?.error === "invalid_state_transition",
      `expected a refusal code, got ${JSON.stringify(body)}`,
    );
    assert.equal(rows.events[0]!.state, "open");
  });

  it("STILL COMPLETES a started event — the healthy twin", async () => {
    const rows = baseRows("started");
    await install(rows);
    const { status, body } = await call("POST", `/events/${EVENT}/complete`);
    assert.equal(status, 200, JSON.stringify(body));
    assert.equal(rows.events[0]!.state, "completed");
  });
});

describe("the conditional UPDATE — a concurrent change wins", () => {
  it("reports conflict rather than clobbering a state that moved under the request", async () => {
    const rows = baseRows("draft");
    // The route reads `draft`, decides draft -> open is legal, then writes
    // conditionally on `state = 'draft'`. Move the row first: the write matches
    // no rows, and the request must NOT report success.
    const c = makeClient(rows);
    let reads = 0;
    const inner = c.from.bind(c);
    (c as any).from = (t: string) => {
      const b = inner(t);
      if (t === "events") {
        const origSelect = b.select.bind(b);
        b.select = (...a: any[]) => {
          // After the route's read of the current row, a concurrent cancel lands.
          if (++reads === 1) queueMicrotask(() => { rows.events[0]!.state = "cancelled"; });
          return origSelect(...a);
        };
      }
      return b;
    };
    _setTestClient(c as any, true);
    _setTestServiceClient(c as any);
    const { status, body } = await call("PATCH", `/events/${EVENT}`, { state: "open" });
    assert.notEqual(status, 200, `a clobbered write must not report success: ${JSON.stringify(body)}`);
    assert.notEqual(rows.events[0]!.state, "open", "the concurrent cancel must win");
  });
});
