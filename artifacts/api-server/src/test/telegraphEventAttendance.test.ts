import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import express from "express";
import { _clearTestClient, _setTestClient } from "../lib/http.js";
import router from "../routes/telegraphSharedContext.js";
// Namespace import, so a tree WITHOUT the T264 gate fails case by case rather than at import.
import * as eventAttendance from "../services/telegraph/eventAttendance.js";

const VIEWER = "aaaaaaaa-0000-4000-8000-000000000001";
const MEMBER = "bbbbbbbb-0000-4000-8000-000000000002";
const OUTSIDER = "cccccccc-0000-4000-8000-000000000003";
const THREAD = "dddddddd-0000-4000-8000-000000000004";
const EVENT = "eeeeeeee-0000-4000-8000-000000000005";
const TRIP = "ffffffff-0000-4000-8000-000000000006";
type Row = Record<string, any>;

function fixture() {
  return {
    message_threads: [{ id: THREAD, thread_type: "direct" }],
    message_thread_members: [VIEWER, MEMBER].map((user_id) => ({ thread_id: THREAD, user_id, left_at: null })),
    event_attendees: [VIEWER, MEMBER, OUTSIDER].map((user_id) => ({ event_id: EVENT, user_id })),
    event_rsvps: [VIEWER, MEMBER, OUTSIDER].map((user_id) => ({ event_id: EVENT, user_id, status: "going" })),
    events: [{ id: EVENT, host_id: OUTSIDER, title: "Rooftop music", state: "open", visibility: "public", starts_at: new Date(Date.now() + 86400000).toISOString() }],
    profiles: [VIEWER, MEMBER, OUTSIDER].map((id) => ({ id, handle: id === MEMBER ? "member" : "traveler", name: id === MEMBER ? "Hidden real name" : "Traveler name", account_status: "active", user_account_states: [] })),
    profile_privacy_settings: [],
    event_roles: [],
    blocks: [],
    feature_flags: [],
  } as Record<string, Row[]>;
}

function clientFor(database: Record<string, Row[]>, failedTable?: string, rejectedTable?: string) {
  const reads: string[] = [];
  return {
    reads,
    auth: { getUser: async () => ({ data: { user: { id: VIEWER } }, error: null }) },
    from(table: string) {
      reads.push(table);
      const filters: Array<(row: Row) => boolean> = [];
      let maximum = Infinity;
      let selected = "*";
      const result = (single = false) => {
        if (table === rejectedTable && (table !== "trip_members" || single)) throw new Error("injected transport rejection");
        if (table === "trip_members" && failedTable === "trip_members_with_data") {
          const row = { trip_id: TRIP, user_id: VIEWER, role: "member", status: "accepted" };
          return { data: single ? row : [row], error: { message: "injected membership failure with stale data" } };
        }
        if (table === failedTable || (failedTable === "member_profile" && table === "profiles" && filters.every((filter) => filter({ id: MEMBER })))) {
          return { data: null, error: { message: "injected read failure" } };
        }
        const rows = (database[table] ?? []).filter((row) => filters.every((filter) => filter(row))).slice(0, maximum);
        const projected = rows.map((row) => selected === "*" ? row : Object.fromEntries(selected.split(",").map((field) => field.trim()).map((field) => [field, row[field]])));
        return { data: single ? projected[0] ?? null : projected, error: null };
      };
      const query: any = {
        select(fields = "*") { selected = fields.includes("(") ? "*" : fields; return query; },
        eq(column: string, value: unknown) { filters.push((row) => row[column] === value); return query; },
        in(column: string, values: unknown[]) { filters.push((row) => values.includes(row[column])); return query; },
        is(column: string, value: unknown) { filters.push((row) => row[column] === value); return query; },
        limit(value: number) { maximum = value; return query; },
        or(expression: string) {
          const clauses = expression.split(",").map((clause) => clause.split(".eq."));
          filters.push((row) => clauses.some(([column, value]) => row[column] === value));
          return query;
        },
        maybeSingle: async () => result(true),
        then(resolve: (value: unknown) => unknown, reject: (error: unknown) => unknown) {
          return Promise.resolve().then(() => result()).then(resolve, reject);
        },
      };
      return query;
    },
  };
}

let server: ReturnType<typeof createServer>;
let base: string;
before(async () => {
  const app = express();
  app.use(router);
  server = createServer(app);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
after(async () => {
  _clearTestClient();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function read(database = fixture(), failedTable?: string, rejectedTable?: string) {
  const client = clientFor(database, failedTable, rejectedTable);
  _setTestClient(client, true);
  const response = await fetch(`${base}/threads/${THREAD}/shared-context`, { headers: { authorization: `Bearer ${VIEWER}` } });
  const body = await response.json() as any;
  const projection = body.sharedContext;
  const event = projection ? [...projection.now, ...projection.upcoming, ...projection.unresolved, ...projection.past].find((item) => item.objectId === EVENT) : undefined;
  return { status: response.status, body, event, reads: client.reads };
}

describe("T264 event attendance on the real Telegraph shared-context route", () => {
  function tripEvent(status: unknown = "accepted", role = "member") {
    const database = fixture();
    database.events[0].visibility = "trip";
    database.events[0].trip_id = TRIP;
    database.trip_members = [{ trip_id: TRIP, user_id: VIEWER, role, status }];
    return database;
  }

  for (const status of ["invited", "pending", "declined", "removed", "left", null, "missing", "Accepted", {}]) {
    it(`withholds private trip event and attendance for non-accepted membership ${JSON.stringify(status)}`, async () => {
      const database = tripEvent(status);
      if (status === "missing") delete database.trip_members[0].status;
      const result = await read(database);
      assert.equal(result.status, 200);
      assert.equal(result.event, undefined);
      assert.equal(JSON.stringify(result.body).includes("Rooftop music"), false);
      assert.equal(JSON.stringify(result.body).includes(database.events[0].starts_at), false);
      assert.equal(JSON.stringify(result.body).includes("@member"), false);
      assert.equal(result.reads.includes("event_rsvps"), false);
    });
  }

  for (const role of ["owner", "co_host", "member", "viewer"]) {
    it(`admits an explicitly accepted trip ${role} to the private event and attendance`, async () => {
      const result = await read(tripEvent("accepted", role));
      assert.equal(result.status, 200);
      assert.equal(result.event.title, "Rooftop music");
      assert.deepEqual(result.event.eventAttendance, [{ userId: VIEWER, label: "You" }, { userId: MEMBER, label: "@member" }]);
    });
    if (role !== "member") {
      it(`does not treat trip ${role} alone as accepted membership`, async () => {
        assert.equal((await read(tripEvent("invited", role))).event, undefined);
      });
    }
  }

  for (const role of ["host", "co_host", "moderator"]) {
    it(`preserves event ${role} access independently of trip membership`, async () => {
      const database = tripEvent("invited");
      if (role === "host") database.events[0].host_id = VIEWER;
      else database.event_roles = [{ event_id: EVENT, user_id: VIEWER, role }];
      const result = await read(database);
      assert.equal(result.status, 200);
      assert.equal(result.event.title, "Rooftop music");
      assert.deepEqual(result.event.eventAttendance, [{ userId: VIEWER, label: "You" }, { userId: MEMBER, label: "@member" }]);
    });
  }

  for (const failure of ["resolved", "thrown", "data_with_error"]) {
    it(`withholds private trip event after ${failure} membership read failure`, async () => {
      const failedTable = failure === "resolved" ? "trip_members" : failure === "data_with_error" ? "trip_members_with_data" : undefined;
      const result = await read(tripEvent(), failedTable, failure === "thrown" ? "trip_members" : undefined);
      assert.equal(result.status, 200);
      assert.equal(result.event, undefined);
      assert.equal(result.body.incomplete, true);
      assert.equal(result.reads.includes("event_rsvps"), false);
    });
  }

  it("rechecks trip acceptance and revocation without trusting stale event attendance", async () => {
    const database = tripEvent("invited");
    assert.equal((await read(database)).event, undefined);
    database.trip_members[0].status = "accepted";
    assert.equal((await read(database)).event.eventAttendance.length, 2);
    database.trip_members[0].status = "removed";
    assert.equal((await read(database)).event, undefined);
  });

  it("names Going members, not outsiders, and never returns an unapproved real name", async () => {
    const result = await read();
    assert.equal(result.status, 200);
    assert.deepEqual(result.event.eventAttendance, [{ userId: VIEWER, label: "You" }, { userId: MEMBER, label: "@member" }]);
    assert.equal(JSON.stringify(result.body).includes("Hidden real name"), false);
    assert.equal(JSON.stringify(result.event.eventAttendance).includes(OUTSIDER), false);
  });

  it("uses opted-in identity and rechecks revocation on the next read", async () => {
    const database = fixture();
    database.profile_privacy_settings = [{ user_id: MEMBER, show_real_name: true }];
    assert.equal((await read(database)).event.eventAttendance[1].label, "Hidden real name");
    database.profile_privacy_settings = [];
    assert.equal((await read(database)).event.eventAttendance[1].label, "@member");
  });

  for (const status of ["maybe", "interested", "cant_go"]) {
    it(`does not call a ${status} RSVP Going even with a legacy attendee row`, async () => {
      const database = fixture();
      database.event_rsvps[1].status = status;
      assert.deepEqual((await read(database)).event.eventAttendance, [{ userId: VIEWER, label: "You" }]);
    });
  }

  it("does not retain a withdrawn RSVP or a departed thread member", async () => {
    const database = fixture();
    assert.equal((await read(database)).event.eventAttendance.length, 2);
    database.event_rsvps = database.event_rsvps.filter((row) => row.user_id !== MEMBER);
    assert.deepEqual((await read(database)).event.eventAttendance, [{ userId: VIEWER, label: "You" }]);
    database.message_thread_members[1].left_at = new Date().toISOString();
    assert.equal((await read(database)).event, undefined);
  });

  it("returns current event timing and live status alongside current attendance", async () => {
    const database = fixture();
    const earlier = await read(database);
    assert.notEqual(earlier.event.orderBand, "HAPPENING_NOW");
    database.events[0].starts_at = new Date(Date.now() - 60000).toISOString();
    database.events[0].ends_at = new Date(Date.now() + 60000).toISOString();
    database.events[0].state = "started";
    const current = await read(database);
    assert.equal(current.event.orderBand, "HAPPENING_NOW");
    assert.equal(current.event.status, "started");
    assert.equal(current.event.startsAt, database.events[0].starts_at);
    assert.equal(current.event.eventAttendance[1].label, "@member");
  });

  for (const status of ["interested", "cant_go", "missing"]) {
    it(`withholds identities from a ${status} viewer, despite the legacy mutuality row`, async () => {
      const database = fixture();
      database.event_rsvps = database.event_rsvps.filter((row) => row.user_id !== VIEWER);
      if (status !== "missing") database.event_rsvps.push({ event_id: EVENT, user_id: VIEWER, status });
      assert.equal((await read(database)).event.eventAttendance, null);
    });
  }

  it("admits a Maybe viewer without mislabelling them as Going", async () => {
    const database = fixture();
    database.event_rsvps[0].status = "maybe";
    assert.deepEqual((await read(database)).event.eventAttendance, [{ userId: MEMBER, label: "@member" }]);
  });

  for (const role of ["host", "co_host"]) {
    it(`preserves the event ${role}'s participant read without requiring a Going RSVP`, async () => {
      const database = fixture();
      database.event_rsvps = database.event_rsvps.filter((row) => row.user_id !== VIEWER);
      if (role === "host") database.events[0].host_id = VIEWER;
      else database.event_roles = [{ event_id: EVENT, user_id: VIEWER, role }];
      assert.deepEqual((await read(database)).event.eventAttendance, [{ userId: MEMBER, label: "@member" }]);
    });
  }

  for (const reverse of [false, true]) {
    it(`withholds a blocked member (${reverse ? "member blocks viewer" : "viewer blocks member"})`, async () => {
      const database = fixture();
      database.blocks = [{ blocker_id: reverse ? MEMBER : VIEWER, blocked_id: reverse ? VIEWER : MEMBER }];
      assert.deepEqual((await read(database)).event.eventAttendance, [{ userId: VIEWER, label: "You" }]);
    });
  }

  for (const failure of ["host_block", "viewer_block", "banned", "cancelled", "private"]) {
    it(`withholds the entire event card when canonical event access is denied (${failure})`, async () => {
      const database = fixture();
      if (failure === "host_block") database.blocks = [{ blocker_id: OUTSIDER, blocked_id: VIEWER }];
      if (failure === "viewer_block") database.blocks = [{ blocker_id: VIEWER, blocked_id: OUTSIDER }];
      if (failure === "banned") database.event_roles = [{ event_id: EVENT, user_id: VIEWER, role: "banned" }];
      if (failure === "cancelled") database.events[0].state = "cancelled";
      if (failure === "private") { database.events[0].visibility = "trip"; database.events[0].trip_id = null; }
      const result = await read(database);
      assert.equal(result.status, 200);
      assert.equal(result.event, undefined);
      assert.equal(JSON.stringify(result.body).includes("Rooftop music"), false);
      assert.equal(JSON.stringify(result.body).includes(database.events[0].starts_at), false);
      assert.equal(JSON.stringify(result.body).includes("JOIN_PLAN"), false);
      assert.equal(result.reads.includes("event_rsvps"), false);
    });
  }

  for (const table of ["event_roles", "blocks"]) {
    for (const failure of ["resolved", "thrown"]) {
      it(`withholds the card and reports incomplete after ${failure} ${table} authorization failure`, async () => {
        const result = await read(fixture(), failure === "resolved" ? table : undefined, failure === "thrown" ? table : undefined);
        assert.equal(result.status, 200);
        assert.equal(result.event, undefined);
        assert.equal(result.body.incomplete, true);
        assert.equal(JSON.stringify(result.body).includes("Rooftop music"), false);
      });
    }
  }

  it("preserves an authorized event card when only attendance is unreadable", async () => {
    const result = await read(fixture(), "event_rsvps");
    assert.equal(result.status, 200);
    assert.equal(result.event.title, "Rooftop music");
    assert.equal(result.event.eventAttendance, null);
  });

  for (const restriction of ["host_block", "banned", "private"]) {
    it(`rechecks whole-card authorization after ${restriction} revocation and recovery`, async () => {
      const database = fixture();
      assert.ok((await read(database)).event);
      if (restriction === "host_block") database.blocks = [{ blocker_id: OUTSIDER, blocked_id: VIEWER }];
      if (restriction === "banned") database.event_roles = [{ event_id: EVENT, user_id: VIEWER, role: "banned" }];
      if (restriction === "private") { database.events[0].visibility = "trip"; database.events[0].trip_id = null; }
      assert.equal((await read(database)).event, undefined);
      database.blocks = [];
      database.event_roles = [];
      database.events[0].visibility = "public";
      assert.ok((await read(database)).event);
    });
  }

  it("preserves the authorized host's cancellation and current timing with unavailable attendance", async () => {
    const database = fixture();
    database.events[0].host_id = VIEWER;
    assert.equal((await read(database)).event.status, "open");
    database.events[0].state = "cancelled";
    database.events[0].starts_at = new Date(Date.now() + 172800000).toISOString();
    const result = await read(database, "event_rsvps");
    assert.equal(result.status, 200);
    assert.equal(result.event.status, "cancelled");
    assert.equal(result.event.startsAt, database.events[0].starts_at);
    assert.equal(result.event.title, "Rooftop music");
    assert.equal(result.event.eventAttendance, null);
  });

  it("fails closed on a rejected RSVP read", async () => {
    assert.equal((await read(fixture(), undefined, "event_rsvps")).event.eventAttendance, null);
  });

  it("keeps handles, not names, when name privacy is unreadable", async () => {
    const database = fixture();
    database.profile_privacy_settings = [{ user_id: MEMBER, show_real_name: true }];
    assert.equal((await read(database, "profile_privacy_settings")).event.eventAttendance[1].label, "@member");
  });

  it("does not turn an unreadable member identity into an empty attendance claim", async () => {
    assert.equal((await read(fixture(), "member_profile")).event.eventAttendance, null);
  });

  for (const status of [null, "Going", "unknown"]) {
    it(`withholds malformed RSVP status ${String(status)}`, async () => {
      const database = fixture();
      database.event_rsvps[1].status = status;
      assert.equal((await read(database)).event.eventAttendance, null);
    });
  }

  it("withholds inconsistent duplicate RSVP rows", async () => {
    const database = fixture();
    database.event_rsvps.push({ event_id: EVENT, user_id: MEMBER, status: "cant_go" });
    assert.equal((await read(database)).event.eventAttendance, null);
  });

  it("does not turn event moderation permission into attendee-list permission", async () => {
    const database = fixture();
    database.event_rsvps = database.event_rsvps.filter((row) => row.user_id !== VIEWER);
    database.event_roles = [{ event_id: EVENT, user_id: VIEWER, role: "moderator" }];
    assert.equal((await read(database)).event.eventAttendance, null);
  });

  it("withholds a restricted member identity and rechecks after recovery", async () => {
    const database = fixture();
    database.profiles[1].account_status = "banned";
    assert.deepEqual((await read(database)).event.eventAttendance, [{ userId: VIEWER, label: "You" }]);
    database.profiles[1].account_status = "active";
    assert.equal((await read(database)).event.eventAttendance[1].label, "@member");
  });

  it("rejects a departed viewer before reading any event attendance", async () => {
    const database = fixture();
    database.message_thread_members[0].left_at = new Date().toISOString();
    const result = await read(database);
    assert.equal(result.status, 403);
    assert.equal(result.reads.includes("event_rsvps"), false);
  });
});

// ── census-telegraph T264: the minimal authorized cancellation notice ─────────
//
// THE DEFECT (2026-10-16 restatement, closure report "next exact work"): the
// canonical event loader withholds a cancelled event from everyone but its host,
// so the rail OMITS it, and an ordinary attendee's rail has nothing whose status
// can change — "called off while you were away" is never promoted to them. The
// card must stay withheld (title, timing, place, host, attendance and actions are
// the event's, and a cancelled event is not shown). What an attendee may be told
// is the one fact that is theirs: the event THEY were attending, by the id their
// own rail already held, was cancelled — and only when they could have seen it
// had it not been, only while the cancellation is still news, and never across a
// block. An unreadable gate is INCOMPLETE, not a notice and not silence.
describe("T264 — an attendee is told their shared event was cancelled: its id and the word, nothing else", () => {
  const NOTICE = { objectType: "EVENT", objectId: EVENT, status: "cancelled" };
  function cancelled(change: (d: Record<string, Row[]>) => void = () => {}) {
    const database = fixture();
    database.events[0].state = "cancelled";
    change(database);
    return database;
  }

  it("an attendee's cancelled shared event arrives as a notice; the card stays withheld and nothing of the event leaks", async () => {
    const database = cancelled();
    const result = await read(database);
    assert.equal(result.status, 200);
    assert.deepEqual(result.body.cancellations, [NOTICE]);
    assert.equal(result.event, undefined, "the event itself is still not in the projection");
    assert.equal(result.body.incomplete, false);
    const text = JSON.stringify(result.body);
    for (const leak of ["Rooftop music", database.events[0].starts_at, OUTSIDER, "JOIN_PLAN", "MEET_HERE", "@member", "public"]) {
      assert.equal(text.includes(leak), false, `the notice carried "${leak}"`);
    }
    assert.equal(result.reads.includes("event_rsvps"), false, "a notice reads no attendance");
  });

  it("a live event carries no notice", async () => {
    const result = await read(fixture());
    assert.ok(result.event);
    assert.deepEqual(result.body.cancellations, []);
  });

  it("the host still gets the card (status cancelled), not a notice", async () => {
    const database = cancelled((d) => { d.events[0].host_id = VIEWER; });
    const result = await read(database);
    assert.equal(result.event.status, "cancelled");
    assert.deepEqual(result.body.cancellations, []);
  });

  const withheld: Array<[string, (d: Record<string, Row[]>) => void]> = [
    ["the host blocked the viewer", (d) => { d.blocks = [{ blocker_id: OUTSIDER, blocked_id: VIEWER }]; }],
    ["the viewer blocked the host", (d) => { d.blocks = [{ blocker_id: VIEWER, blocked_id: OUTSIDER }]; }],
    ["the viewer is banned from the event", (d) => { d.event_roles = [{ event_id: EVENT, user_id: VIEWER, role: "banned" }]; }],
    ["the viewer could not have seen it (a trip event, no accepted membership)", (d) => {
      d.events[0].visibility = "trip"; d.events[0].trip_id = TRIP; d.trip_members = [{ trip_id: TRIP, user_id: VIEWER, role: "member", status: "removed" }];
    }],
    ["it is a draft, not a cancellation", (d) => { d.events[0].state = "draft"; }],
    ["its scheduled time has passed", (d) => {
      d.events[0].starts_at = new Date(Date.now() - 3 * 86400000).toISOString();
      d.events[0].ends_at = new Date(Date.now() - 3 * 86400000 + 7200000).toISOString();
    }],
    ["nobody else in the conversation was attending", (d) => { d.event_attendees = d.event_attendees.filter((r) => r.user_id !== MEMBER); }],
    ["the viewer was not attending", (d) => { d.event_attendees = d.event_attendees.filter((r) => r.user_id !== VIEWER); }],
  ];
  for (const [label, change] of withheld) {
    it(`no notice when ${label}`, async () => {
      const database = cancelled(change);
      const result = await read(database);
      assert.equal(result.status, 200);
      assert.deepEqual(result.body.cancellations, []);
      assert.equal(JSON.stringify(result.body).includes(EVENT), false, "not even the id");
    });
  }

  for (const failure of ["resolved", "thrown"]) {
    it(`an unreadable visibility gate (${failure} trip_members) is incomplete, not a notice`, async () => {
      const database = cancelled((d) => {
        d.events[0].visibility = "trip"; d.events[0].trip_id = TRIP; d.trip_members = [{ trip_id: TRIP, user_id: VIEWER, role: "member", status: "accepted" }];
      });
      const result = await read(database, failure === "resolved" ? "trip_members" : undefined, failure === "thrown" ? "trip_members" : undefined);
      assert.equal(result.status, 200);
      assert.deepEqual(result.body.cancellations, []);
      assert.equal(result.body.incomplete, true);
    });
  }

  it("an accepted trip member of a cancelled trip event is told", async () => {
    const database = cancelled((d) => {
      d.events[0].visibility = "trip"; d.events[0].trip_id = TRIP; d.trip_members = [{ trip_id: TRIP, user_id: VIEWER, role: "member", status: "accepted" }];
    });
    assert.deepEqual((await read(database)).body.cancellations, [NOTICE]);
  });

  it("re-checked on every read: a block placed after the cancellation withdraws the notice", async () => {
    const database = cancelled();
    assert.deepEqual((await read(database)).body.cancellations, [NOTICE]);
    database.blocks = [{ blocker_id: OUTSIDER, blocked_id: VIEWER }];
    assert.deepEqual((await read(database)).body.cancellations, []);
  });
});

// The gate itself, called directly, so each of its own checks is shown to
// refuse — not merely the checks the rail's resolver happens to run first. Its
// block read is the shared fail-closed helper (lib/blockGuard), whose `.or(and…)`
// filter this small fake understands.
describe("T264 — readEventCancellation, gate by gate", () => {
  function gateClient(db: Record<string, Row[]>, failing?: string) {
    return {
      from(table: string) {
        const filters: Array<(row: Row) => boolean> = [];
        const result = (single: boolean) => {
          if (table === failing) return { data: null, error: { message: "injected read failure" } };
          const rows = (db[table] ?? []).filter((row) => filters.every((f) => f(row)));
          return { data: single ? rows[0] ?? null : rows, error: null };
        };
        const q: any = {
          select() { return q; },
          eq(c: string, v: unknown) { filters.push((r) => r[c] === v); return q; },
          in(c: string, vs: unknown[]) { filters.push((r) => vs.includes(r[c])); return q; },
          limit() { return q; },
          or(expr: string) {
            const groups = [...expr.matchAll(/and\(([^)]*)\)/g)].map((m) => m[1].split(",").map((p) => p.split(".eq.")));
            filters.push((r) => groups.some((g) => g.every(([c, v]) => r[c] === v)));
            return q;
          },
          maybeSingle: async () => result(true),
          then(res: (v: unknown) => unknown, rej: (e: unknown) => unknown) { return Promise.resolve().then(() => result(false)).then(res, rej); },
        };
        return q;
      },
    };
  }
  const base = () => ({
    events: [{ id: EVENT, host_id: OUTSIDER, title: "Rooftop music", state: "cancelled", visibility: "public", starts_at: new Date(Date.now() + 86400000).toISOString(), ends_at: null }],
    event_attendees: [{ event_id: EVENT, user_id: VIEWER }],
    event_roles: [], blocks: [], feature_flags: [], trip_members: [],
  } as Record<string, Row[]>);
  const gate = (db: Record<string, Row[]>, failing?: string) =>
    (eventAttendance as Record<string, any>).readEventCancellation(gateClient(db, failing) as any, EVENT, VIEWER, Date.now());

  it("an attendee of a cancelled event they could see: cancelled", async () => {
    assert.equal(await gate(base()), "cancelled");
  });
  it("not an attendee: withheld", async () => {
    const db = base(); db.event_attendees = [];
    assert.equal(await gate(db), "withheld");
  });
  for (const [blocker, blocked] of [[OUTSIDER, VIEWER], [VIEWER, OUTSIDER]]) {
    it(`a block ${blocker === VIEWER ? "by the viewer" : "by the host"}: withheld`, async () => {
      const db = base(); db.blocks = [{ blocker_id: blocker, blocked_id: blocked }];
      assert.equal(await gate(db), "withheld");
    });
  }
  it("an unreadable blocks table denies (the shared helper fails closed): withheld", async () => {
    assert.equal(await gate(base(), "blocks"), "withheld");
  });
  // Event staff skip checkEventEligibility's own block check (and a co-host passes the visibility
  // read by role), so for them this gate's block read is the only one: "blocking overrides all
  // other relationships" holds for the notice as it does for the card.
  it("a co-host the host blocked, or whose blocks read fails: withheld", async () => {
    const staff = base(); staff.event_roles = [{ event_id: EVENT, user_id: VIEWER, role: "co_host" }];
    assert.equal(await gate(staff), "cancelled", "the control: an unblocked co-host who attended is told");
    staff.blocks = [{ blocker_id: OUTSIDER, blocked_id: VIEWER }];
    assert.equal(await gate(staff), "withheld");
    staff.blocks = [];
    assert.equal(await gate(staff, "blocks"), "withheld");
  });
  it("not cancelled, or the viewer is the host: withheld", async () => {
    const live = base(); live.events[0].state = "open";
    assert.equal(await gate(live), "withheld");
    const host = base(); host.events[0].host_id = VIEWER;
    assert.equal(await gate(host), "withheld");
  });
  it("its time has passed — by its end, or six hours after a start with no end: withheld", async () => {
    const ended = base(); ended.events[0].ends_at = new Date(Date.now() - 60000).toISOString();
    assert.equal(await gate(ended), "withheld");
    const started = base(); started.events[0].starts_at = new Date(Date.now() - 7 * 3600000).toISOString();
    assert.equal(await gate(started), "withheld");
    const recent = base(); recent.events[0].starts_at = new Date(Date.now() - 5 * 3600000).toISOString();
    assert.equal(await gate(recent), "cancelled", "still news inside the six-hour window");
  });
  it("a ban: withheld; an unreadable ban: unavailable", async () => {
    const banned = base(); banned.event_roles = [{ event_id: EVENT, user_id: VIEWER, role: "banned" }];
    assert.equal(await gate(banned), "withheld");
    assert.equal(await gate(base(), "event_roles"), "unavailable");
  });
  it("visibility as if not cancelled: a trip event needs accepted membership; an unreadable one is unavailable", async () => {
    const trip = base(); trip.events[0].visibility = "trip"; trip.events[0].trip_id = TRIP;
    assert.equal(await gate(trip), "withheld");
    trip.trip_members = [{ trip_id: TRIP, user_id: VIEWER, role: "member", status: "accepted" }];
    assert.equal(await gate(trip), "cancelled");
    assert.equal(await gate(trip, "trip_members"), "unavailable");
  });
  it("an unreadable event or attendee row is unavailable, never a notice", async () => {
    assert.equal(await gate(base(), "events"), "unavailable");
    assert.equal(await gate(base(), "event_attendees"), "unavailable");
  });
});
