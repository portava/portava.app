/**
 * REV-020 — `PATCH /events/:id` holds a ticket link to the same host allowlist
 * as create and publish (docs/architecture/08_Portava_Revenue_Model.md §3.5).
 *
 * ── THE DEFECT ───────────────────────────────────────────────────────────────
 * `POST /events` (publishNow), `POST /event-drafts/:id/publish` and
 * `POST /events/:id/publish` all call `checkTicketUrl`. The update handler did
 * not:
 *
 *     if (b.priceUrl !== undefined) patch.price_url = b.priceUrl;   // ← written raw
 *
 * so the host or a co-host of an event that had passed the check at publish
 * could afterwards repoint its ticket link at any host. The same handler also
 * performs the legal `draft -> open` transition, so a draft holding a link that
 * `POST /events/:id/publish` would refuse could be published by PATCH instead.
 *
 * ── WHAT "UPDATE" MEANS FOR THE LINK ─────────────────────────────────────────
 * The app's composer sends the stored link back with every edit. So the rule
 * cannot be "a body that carries an unlisted link is refused": that turns a
 * link stored before the rule into a lock on the whole event. The rule is:
 *
 *   * a CHANGE of the link to a refused value is refused, in any state;
 *   * the stored value sent back is not a change, and is not rewritten;
 *   * `priceUrl: null` removes the link, and so does `priceType: "free"` with
 *     no `priceUrl` (a free event carries no link);
 *   * PUBLISHING a draft whose link, as the request leaves it, is refused is
 *     refused — with the sentence that tells the host to remove or replace it.
 *
 * And a link is https or it is refused: `javascript://eventbrite.com/…` and
 * `intent://eventbrite.com/…` carry an allowlisted HOST, and the app hands the
 * stored string to the operating system.
 *
 * ── WHAT IS PROVEN HERE, OVER THE REAL ROUTER ────────────────────────────────
 * Every case asserts the STORED row afterwards, not only the status: a 400 that
 * had already written the link would satisfy a status-only assertion. Every
 * refusal asserts the allowlist MESSAGE as well as the code, because the zod
 * schema answers `invalid_payload` too — a body rejected at validation never
 * reaches the check and would prove nothing about it. Each refusal has its
 * healthy twin: a handler that refused every `priceUrl` would pass the
 * refusals and break ticketed events.
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx/esm --test src/test/eventsTicketUrlOnUpdate.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import eventsRouter from "../routes/events.js";

const HOST  = "aaaaaaaa-7777-4000-a000-000000000001";
const EVENT = "bbbbbbbb-7777-4000-a000-000000000002";
const TOK   = "tok-host";

const LISTED   = "https://www.eventbrite.com/e/portava-rooftop-123";
const LISTED_2 = "https://dice.fm/event/portava-rooftop-456";
const UNLISTED = "https://phishingsite.xyz/buy-ticket";
const UNLISTED_2 = "https://another-seller.example/t/9";
/** An allowlisted HOST under a scheme that is not https. The first two are the ones the app would hand to the OS. */
const NOT_HTTPS = [
  "javascript://eventbrite.com/%0aalert(1)",
  "intent://eventbrite.com/#Intent;scheme=https;package=com.evil.app;end",
  "http://www.eventbrite.com/e/portava-rooftop-123",
];

type Rows = Record<string, any[]>;
interface Write { table: string; patch: any; matched: number }

/**
 * Table-driven fake, the shape eventStateTransitionAuthority.test.ts uses.
 * UPDATEs mutate the backing rows and honour `.eq()` filters, so "the stored
 * row" below is what a read after the request would return; every UPDATE is
 * also recorded, so "nothing was written" is asserted, not inferred.
 */
function makeClient(rows: Rows, writes: Write[]) {
  function chain(table: string) {
    const filters: Array<(r: any) => boolean> = [];
    let patch: any = null;
    let inserted: any = null;
    function matched() {
      return (rows[table] ?? []).filter((r) => filters.every((f) => f(r)));
    }
    function settle(single: boolean) {
      if (patch !== null) {
        const hit = matched();
        writes.push({ table, patch, matched: hit.length });
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

function baseRows(state: string, priceUrl: string | null): Rows {
  return {
    feature_flags: [{ flag: "events_enabled", enabled: true }],
    events: [{
      id: EVENT, host_id: HOST, state, visibility: "public", title: "Rooftop set",
      description: "d", location_name: "The Roof", chat_enabled: false,
      starts_at: new Date(Date.now() + 86_400_000).toISOString(), ends_at: null,
      max_attendees: null, waitlist_enabled: false, rsvp_closed: false,
      price_type: priceUrl ? "external" : "free", price_url: priceUrl,
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
  // Without this shim these routes CRASH on req.log, and a 500-from-crash would
  // be indistinguishable from a deliberate refusal.
  app.use((req: any, _res, next) => {
    req.log = { info() {}, warn() {}, error() {}, debug() {} };
    next();
  });
  app.use(eventsRouter);
  server = createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as any).port}`;
});

after(async () => {
  _setTestClient(null as any, false);
  _setTestServiceClient(null as any);
  await new Promise<void>((r) => server.close(() => r()));
});

function install(rows: Rows): Write[] {
  const writes: Write[] = [];
  const c = makeClient(rows, writes);
  _setTestClient(c as any, true);
  _setTestServiceClient(c as any);
  return writes;
}

async function patch(body: unknown) {
  const res = await fetch(`${base}/events/${EVENT}`, {
    method: "PATCH",
    headers: { authorization: `Bearer ${TOK}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const json: any = await res.json().catch(() => ({}));
  return { status: res.status, body: json };
}

async function post(path: string, body: unknown) {
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${TOK}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const json: any = await res.json().catch(() => ({}));
  return { status: res.status, body: json };
}

const HOST_MSG   = /^Ticket URL host is not on the allowlist \(.*eventbrite\.com.*\)$/;
const SCHEME_MSG = /^Ticket URL must be an https link$/;
/** The publish refusal: the same sentence, then the way out. */
const PUBLISH_MSG = /^Ticket URL (host is not on the allowlist \(.*eventbrite\.com.*\)|must be an https link)\. Remove the ticket link or replace it with an allowed one, then publish\.$/;

/** The refusal create answers with: 400, `invalid_payload`, a "Ticket URL …" message, and nothing else. */
function assertTicketRefusal(r: { status: number; body: any }, message: RegExp = HOST_MSG) {
  assert.equal(r.status, 400, JSON.stringify(r.body));
  assert.equal(r.body?.error, "invalid_payload", JSON.stringify(r.body));
  // The MESSAGE is what separates this check from the zod schema, which also
  // answers invalid_payload ("Invalid url") for a body that never reached it.
  assert.match(String(r.body?.message), message);
  // …and what the app recognises a link refusal by (travel-buddy-standalone/src/lib/ticketLink.ts).
  assert.ok(String(r.body?.message).startsWith("Ticket URL"), r.body?.message);
  assert.deepEqual(Object.keys(r.body).sort(), ["error", "message"], "the envelope carries the two fields create's does");
}

const eventWrites = (writes: Write[]) => writes.filter((w) => w.table === "events");

describe("PATCH /events/:id — a CHANGE of the ticket link to an unlisted host is refused and nothing is stored", () => {
  it("REFUSES an unlisted host on a published event; the stored link is unchanged", async () => {
    const rows = baseRows("open", LISTED);
    const writes = install(rows);
    assertTicketRefusal(await patch({ priceUrl: UNLISTED }));
    assert.equal(rows.events[0]!.price_url, LISTED, "the stored link moved although the request was refused");
    assert.deepEqual(eventWrites(writes), [], "a refused request must not write the event at all");
  });

  it("REFUSES it on an event that had no link, and none is stored", async () => {
    const rows = baseRows("open", null);
    const writes = install(rows);
    assertTicketRefusal(await patch({ priceType: "external", priceUrl: UNLISTED }));
    assert.equal(rows.events[0]!.price_url, null);
    assert.equal(rows.events[0]!.price_type, "free", "priceType was written although the request was refused");
    assert.deepEqual(eventWrites(writes), []);
  });

  it("REFUSES a look-alike host: the allowlisted name as a prefix, or only in the query", async () => {
    for (const url of [
      "https://eventbrite.com.tickets-portal.example/e/1",
      "https://tickets-portal.example/?next=https://eventbrite.com/e/1",
      "https://noteventbrite.com/e/1",
      "https://eventbrite.com@tickets-portal.example/e/1",
    ]) {
      const rows = baseRows("open", LISTED);
      const writes = install(rows);
      assertTicketRefusal(await patch({ priceUrl: url }));
      assert.equal(rows.events[0]!.price_url, LISTED, `${url} replaced the stored link`);
      assert.deepEqual(eventWrites(writes), [], url);
    }
  });

  it("refuses the WHOLE request: fields sent alongside the unlisted link are not written either", async () => {
    const rows = baseRows("open", LISTED);
    const writes = install(rows);
    assertTicketRefusal(await patch({ title: "Renamed", priceUrl: UNLISTED }));
    assert.equal(rows.events[0]!.title, "Rooftop set");
    assert.equal(rows.events[0]!.price_url, LISTED);
    assert.deepEqual(eventWrites(writes), []);
  });

  it("REFUSES it on a draft too, and before any state write", async () => {
    const rows = baseRows("draft", null);
    const writes = install(rows);
    assertTicketRefusal(await patch({ state: "open", priceUrl: UNLISTED }));
    assert.equal(rows.events[0]!.state, "draft", "the draft was published although its link was refused");
    assert.equal(rows.events[0]!.price_url, null);
    assert.deepEqual(eventWrites(writes), []);
  });

  it("REFUSES replacing a stored unlisted link with ANOTHER unlisted one: an old link is not a licence for a new one", async () => {
    const rows = baseRows("open", UNLISTED);
    const writes = install(rows);
    assertTicketRefusal(await patch({ title: "Renamed", priceType: "external", priceUrl: UNLISTED_2, state: "open" }));
    assert.equal(rows.events[0]!.price_url, UNLISTED, "the stored link was replaced by another unlisted one");
    assert.equal(rows.events[0]!.title, "Rooftop set");
    assert.deepEqual(eventWrites(writes), []);
  });
});

describe("PATCH /events/:id — a link is https, or it is refused", () => {
  it("REFUSES every other scheme on an allowlisted host, in any state; the stored link is unchanged", async () => {
    for (const state of ["open", "draft"]) {
      for (const url of NOT_HTTPS) {
        const rows = baseRows(state, LISTED);
        const writes = install(rows);
        const r = await patch({ priceUrl: url });
        // The schema lets these through (`z.string().url()` accepts any scheme);
        // if it ever stops, this message assertion says so instead of passing.
        assertTicketRefusal(r, SCHEME_MSG);
        assert.equal(rows.events[0]!.price_url, LISTED, `${url} replaced the stored link on a ${state} event`);
        assert.deepEqual(eventWrites(writes), [], url);
      }
    }
  });

  it("REFUSES publishing a draft whose STORED link is not https, and says how to get out", async () => {
    for (const url of NOT_HTTPS) {
      const rows = baseRows("draft", url);
      const writes = install(rows);
      assertTicketRefusal(await patch({ state: "open" }), PUBLISH_MSG);
      assert.equal(rows.events[0]!.state, "draft", `a draft whose link is ${url} was published`);
      assert.deepEqual(eventWrites(writes), []);
    }
  });

  it("the twin: an https link on an allowlisted host is stored", async () => {
    const rows = baseRows("open", null);
    install(rows);
    const r = await patch({ priceType: "external", priceUrl: LISTED });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(rows.events[0]!.price_url, LISTED);
  });
});

describe("POST /events — create holds the link to https too, draft or published", () => {
  const draft = { title: "Rooftop set", publishNow: false, priceType: "external" };

  it("REFUSES a link that is not https, and no event is created", async () => {
    for (const url of NOT_HTTPS) {
      for (const publishNow of [false, true]) {
        const rows = baseRows("open", null);
        install(rows);
        const before = rows.events.length;
        const r = await post("/events", { ...draft, publishNow, startsAt: new Date(Date.now() + 86_400_000).toISOString(), priceUrl: url });
        assertTicketRefusal(r, SCHEME_MSG);
        assert.equal(rows.events.length, before, `an event was created with ${url} as its ticket link (publishNow ${publishNow})`);
      }
    }
  });

  it("REFUSES an unlisted https host when publishing at once (the rule create already had)", async () => {
    const rows = baseRows("open", null);
    install(rows);
    const before = rows.events.length;
    const r = await post("/events", { ...draft, publishNow: true, startsAt: new Date(Date.now() + 86_400_000).toISOString(), priceUrl: UNLISTED });
    assertTicketRefusal(r, HOST_MSG);
    assert.equal(rows.events.length, before);
  });

  it("the twin: the same body with an https link on an allowlisted host is not refused for its link", async () => {
    const rows = baseRows("open", null);
    install(rows);
    const r = await post("/events", { ...draft, priceUrl: LISTED });
    assert.ok(!String(r.body?.message ?? "").startsWith("Ticket URL"), `a listed https link was refused: ${JSON.stringify(r.body)}`);
    assert.ok(r.status === 200 || r.status === 201, `create failed for another reason, so this twin proves nothing: ${r.status} ${JSON.stringify(r.body)}`);
    const made = rows.events.find((e) => e.id !== EVENT);
    assert.equal(made?.price_url, LISTED, "the created event does not carry the link");
  });
});

describe("PATCH /events/:id — the healthy twins: listed links, clearing, and edits that re-send the stored link", () => {
  it("an allowlisted link replaces the stored one", async () => {
    const rows = baseRows("open", LISTED);
    install(rows);
    const r = await patch({ priceUrl: LISTED_2 });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(rows.events[0]!.price_url, LISTED_2);
    // The host is a participant, so the response carries the link it stored.
    assert.equal(r.body?.priceUrl, LISTED_2);
  });

  it("an allowlisted link is stored on an event that had none", async () => {
    const rows = baseRows("open", null);
    install(rows);
    const r = await patch({ priceType: "external", priceUrl: LISTED });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(rows.events[0]!.price_url, LISTED);
    assert.equal(rows.events[0]!.price_type, "external");
  });

  it("an allowlisted link replaces a stored UNLISTED one", async () => {
    const rows = baseRows("open", UNLISTED);
    install(rows);
    const r = await patch({ priceType: "external", priceUrl: LISTED });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(rows.events[0]!.price_url, LISTED);
  });

  it("`priceUrl: null` clears the link", async () => {
    const rows = baseRows("open", LISTED);
    install(rows);
    const r = await patch({ priceType: "free", priceUrl: null });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(rows.events[0]!.price_url, null, "the link was not cleared");
    assert.equal(rows.events[0]!.price_type, "free");
  });

  it("`priceType: \"free\"` with NO priceUrl clears the link: what an app build that never sends null sends", async () => {
    for (const stored of [LISTED, UNLISTED, NOT_HTTPS[0]!]) {
      const rows = baseRows("open", stored);
      install(rows);
      const r = await patch({ title: "Renamed", priceType: "free" });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal(rows.events[0]!.price_url, null, `a free event still carries ${stored}`);
      assert.equal(rows.events[0]!.price_type, "free");
      assert.equal(rows.events[0]!.title, "Renamed");
    }
  });

  it("…and `priceType: \"external\"` with no priceUrl leaves the stored link exactly as it is", async () => {
    const rows = baseRows("open", LISTED);
    install(rows);
    const r = await patch({ title: "Renamed", priceType: "external" });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(rows.events[0]!.price_url, LISTED, "a missing priceUrl cleared the link of a ticketed event");
  });

  it("an edit that does not name the link is not blocked by a link stored before the rule", async () => {
    // A row that predates the check (or was written through the hole it closes).
    // Refusing every later edit of it would lock the host out of fixing a time
    // or a venue; the link itself can only be changed to a listed host or cleared.
    const rows = baseRows("open", UNLISTED);
    install(rows);
    const r = await patch({ title: "Renamed" });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(rows.events[0]!.title, "Renamed");
    assert.equal(rows.events[0]!.price_url, UNLISTED, "an edit that did not name the link changed it");
  });

  it("THE COMPOSER'S EDIT: a title edit that sends the stored unlisted link back succeeds and leaves the link as it was", async () => {
    // What EventComposerSheet sends for "change the title" on a published,
    // ticketed event: every field, the stored link among them, and the state.
    for (const stored of [UNLISTED, ...NOT_HTTPS]) {
      const rows = baseRows("open", stored);
      install(rows);
      const r = await patch({ title: "Renamed", description: "d", priceType: "external", priceUrl: stored, state: "open", chatEnabled: false, waitlistEnabled: false, visibility: "public" });
      assert.equal(r.status, 200, `an edit that re-sent the stored link ${stored} was refused: ${JSON.stringify(r.body)}`);
      assert.equal(rows.events[0]!.title, "Renamed", "the title edit did not land");
      assert.equal(rows.events[0]!.price_url, stored, "the stored link changed");
      assert.equal(rows.events[0]!.state, "open");
    }
  });

  it("…and the same for a draft that stays a draft", async () => {
    const rows = baseRows("draft", UNLISTED);
    install(rows);
    const r = await patch({ title: "Renamed", priceType: "external", priceUrl: UNLISTED, state: "draft" });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(rows.events[0]!.title, "Renamed");
    assert.equal(rows.events[0]!.price_url, UNLISTED);
    assert.equal(rows.events[0]!.state, "draft");
  });
});

describe("PATCH /events/:id — publishing a draft never exposes a link the allowlist refuses", () => {
  it("REFUSES draft -> open while the draft's stored link is unlisted; the draft stays a draft and the host is told the way out", async () => {
    const rows = baseRows("draft", UNLISTED);
    const writes = install(rows);
    assertTicketRefusal(await patch({ state: "open" }), PUBLISH_MSG);
    assert.equal(rows.events[0]!.state, "draft", "a draft with an unlisted ticket link was published by PATCH");
    assert.deepEqual(eventWrites(writes), []);
  });

  it("REFUSES it when the composer sends the stored unlisted link back with the publish: unchanged is not the same as publishable", async () => {
    const rows = baseRows("draft", UNLISTED);
    const writes = install(rows);
    assertTicketRefusal(await patch({ title: "Renamed", priceType: "external", priceUrl: UNLISTED, state: "open" }), PUBLISH_MSG);
    assert.equal(rows.events[0]!.state, "draft");
    assert.equal(rows.events[0]!.title, "Rooftop set", "a refused publish wrote the title");
    assert.deepEqual(eventWrites(writes), []);
  });

  it("ALLOWS it once the same request replaces the link with a listed one", async () => {
    const rows = baseRows("draft", UNLISTED);
    install(rows);
    const r = await patch({ state: "open", priceUrl: LISTED });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(rows.events[0]!.state, "open");
    assert.equal(rows.events[0]!.price_url, LISTED);
  });

  it("ALLOWS it once the same request REMOVES the link — by null, or by making the event free — and the published event carries none", async () => {
    for (const body of [
      { state: "open", priceType: "free", priceUrl: null },   // the app, after "Remove link"
      { state: "open", priceUrl: null },
      { state: "open", priceType: "free" },                    // a build that never sends null
    ]) {
      const rows = baseRows("draft", UNLISTED);
      install(rows);
      const r = await patch(body);
      assert.equal(r.status, 200, `${JSON.stringify(body)}: ${JSON.stringify(r.body)}`);
      assert.equal(rows.events[0]!.state, "open", JSON.stringify(body));
      assert.equal(rows.events[0]!.price_url, null, `${JSON.stringify(body)} published the event with its unlisted link still stored`);
    }
  });

  it("ALLOWS draft -> open for a draft whose stored link is listed, and for one with no link", async () => {
    for (const stored of [LISTED, null]) {
      const rows = baseRows("draft", stored);
      install(rows);
      const r = await patch({ state: "open" });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal(rows.events[0]!.state, "open");
      assert.equal(rows.events[0]!.price_url, stored);
    }
  });
});
