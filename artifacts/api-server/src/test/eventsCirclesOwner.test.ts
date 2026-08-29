/**
 * GET /api/events/circles — owner visibility
 *
 * The live circle_memberships table stores (user_id = circle owner,
 * other_id = member); a circle's id is its owner's user id and the owner has
 * NO self-membership row. This test verifies the viewer's own circle is
 * always included, so owners see their own circle-scoped events.
 */
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { Server } from "node:http";
import app from "../app.js";
import { _setTestClient } from "../lib/http.js";

interface Row { [k: string]: any; }

const OWNER  = "00000000-0000-4000-8000-00000000aaaa";
const MEMBER = "00000000-0000-4000-8000-00000000bbbb";
const EVENT_ID = "00000000-0000-4000-8000-00000000e001";

function makeFakeClient(tables: Record<string, Row[]>) {
  const db: Record<string, Row[]> = { ...tables };

  function chain(tableName: string) {
    const rowsFor = () => db[tableName] ?? [];
    let filters: Array<(r: Row) => boolean> = [];
    let single = false;

    const obj: any = {
      select() { return obj; },
      eq(col: string, val: any)  { filters.push((r) => r[col] === val); return obj; },
      neq(col: string, val: any) { filters.push((r) => r[col] !== val); return obj; },
      in(col: string, vals: any[]) { filters.push((r) => vals.includes(r[col])); return obj; },
      gt(col: string, val: any)  { filters.push((r) => r[col] > val); return obj; },
      gte() { return obj; },
      lte() { return obj; },
      is() { return obj; },
      not(col: string, op: string, val: string) {
        if (op === "in") {
          const list = val.replace(/[()"]/g, "").split(",").map((s) => s.trim());
          filters.push((r) => !list.includes(r[col]));
        }
        return obj;
      },
      or() { return obj; },
      order() { return obj; },
      limit() { return obj; },
      range() { return obj; },
      maybeSingle() { single = true; return obj; },
      then(resolve: (v: any) => void) {
        const data = rowsFor().filter((r) => filters.every((f) => f(r)));
        resolve(single
          ? { data: data[0] ?? null, error: null }
          : { data, error: null, count: data.length });
      },
    };
    return obj;
  }

  return {
    auth: {
      getUser: async (token: string) => ({
        data: { user: { id: token.replace("tok-", "") } },
        error: null,
      }),
    },
    from: (t: string) => chain(t),
  };
}

let server: Server | null = null;

function listen(): Promise<string> {
  return new Promise((resolve) => {
    server = createServer(app);
    server.listen(0, "127.0.0.1", () => {
      const addr = server!.address() as { port: number };
      resolve(`http://127.0.0.1:${addr.port}`);
    });
  });
}

afterEach(() => {
  _setTestClient(null, false);
  server?.close();
  server = null;
});

const baseEvent = {
  id: EVENT_ID,
  host_id: OWNER,
  circle_id: OWNER, // circle id == owner's user id
  title: "Circle dinner",
  state: "open",
  visibility: "circle",
  starts_at: new Date(Date.now() + 86400_000).toISOString(),
  age_min: null,
  age_max: null,
  trust_score_min: null,
  verified_only: false,
  max_attendees: null,
  waitlist_enabled: false,
};

describe("GET /api/events/circles — owner sees own circle events", () => {
  it("includes the owner's own circle even without a self-membership row", async () => {
    const client = makeFakeClient({
      feature_flags: [],
      circle_memberships: [], // owner has NO self-membership row
      events: [baseEvent],
      blocks: [],
      event_roles: [],
      profiles: [{ id: OWNER, name: "Owner", avatar_url: null }],
      profile_privacy_settings: [],
      event_rsvps: [],
    });
    _setTestClient(client, true);

    const base = await listen();
    const res = await fetch(`${base}/api/events/circles`, {
      headers: { Authorization: `Bearer tok-${OWNER}` },
    });
    assert.equal(res.status, 200);
    const body = await res.json() as any;
    assert.equal(body.events.length, 1);
    assert.equal(body.events[0].id, EVENT_ID);
  });

  it("still includes circles the viewer is a member of (other_id = viewer)", async () => {
    const client = makeFakeClient({
      feature_flags: [],
      circle_memberships: [{ user_id: OWNER, other_id: MEMBER, status: "accepted" }],
      events: [baseEvent],
      blocks: [],
      event_roles: [],
      profiles: [{ id: OWNER, name: "Owner", avatar_url: null }],
      profile_privacy_settings: [],
      event_rsvps: [],
    });
    _setTestClient(client, true);

    const base = await listen();
    const res = await fetch(`${base}/api/events/circles`, {
      headers: { Authorization: `Bearer tok-${MEMBER}` },
    });
    assert.equal(res.status, 200);
    const body = await res.json() as any;
    assert.equal(body.events.length, 1, "member should see the owner's circle event");
  });
});
