/**
 * The Telegraph share card for a Memory or a Highlight takes the same read
 * gate as the object's own routes — lane R wave-1 verification, finding F1
 * (2026-10-06).
 *
 * `POST /api/threads/:threadId/share-projections` resolves any (type, id) pair
 * an active thread member names, through the service client. Before this
 * change:
 *   - `loadHighlight` never read `blocks` at all, though the §10/§11 verdict it
 *     calls states that its caller "has ALREADY applied blocks": a viewer the
 *     owner blocked, or who blocked the owner, resolved the owner's caption and
 *     media URL into a chat card by id;
 *   - `loadMemory` read blocks in ONE direction (owner -> viewer) and honoured
 *     `allowed_user_ids` under ANY visibility, so an `only_me` Memory with a
 *     stale allow-list entry served its title and city while `canReadMemory`
 *     refused it.
 *
 * Every case drives `resolveShareProjections`, the function the route calls,
 * and asserts the card the viewer would get — available with its title, or
 * unavailable with §5.3's reason and NO projection. The intended cases (an
 * unblocked public Highlight and Memory; a `custom` Memory the viewer is
 * allow-listed on) stay available.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolveShareProjections } from "../services/telegraph/shareables.js";

const ALICE = "aaaaaaaa-0000-4000-8000-000000000001"; // the viewer
const BOB = "bbbbbbbb-0000-4000-8000-000000000002"; // the owner
const THREAD = "dddddddd-0000-4000-8000-00000000000d";

const HL = "aa110000-0000-4000-8000-0000000000a1";
const M_PUBLIC = "cc110000-0000-4000-8000-0000000000c1";
const M_ONLY_ME_STALE = "cc110000-0000-4000-8000-0000000000c2";
const M_CUSTOM = "cc110000-0000-4000-8000-0000000000c3";
const M_HIDDEN = "cc110000-0000-4000-8000-0000000000c4";

type Row = Record<string, unknown>;
interface Result { data: unknown; error: unknown }

interface Builder extends PromiseLike<Result> {
  select(cols?: string): Builder;
  eq(c: string, v: unknown): Builder;
  neq(c: string, v: unknown): Builder;
  in(c: string, vs: readonly unknown[]): Builder;
  is(c: string, v: unknown): Builder;
  not(c: string, op: string, v: unknown): Builder;
  order(c?: string, o?: unknown): Builder;
  limit(n: number): Builder;
  maybeSingle(): Promise<Result>;
  single(): Promise<Result>;
}

const soon = () => new Date(Date.now() + 6 * 3600_000).toISOString();

function tables(): Record<string, Row[]> {
  return {
    highlights: [{
      id: HL, owner_id: BOB, caption: "Sunset from the roof", location_name: "Rooftop", location_city: "Hue",
      visibility: "public", expires_at: soon(), deleted_at: null, archived_at: null,
      media_url: "https://x/h1.jpg", media_type: "image", updated_at: "2026-05-01T00:00:00.000Z",
    }],
    memories: [
      { id: M_PUBLIC, owner_id: BOB, title: "The old harbour", caption: null, visibility: "public", allowed_user_ids: [], hidden_user_ids: [], state: "published", trip_id: null, location_city: "Hue", updated_at: "2026-05-01T00:00:00.000Z" },
      { id: M_ONLY_ME_STALE, owner_id: BOB, title: "Just for me", caption: null, visibility: "only_me", allowed_user_ids: [ALICE], hidden_user_ids: [], state: "published", trip_id: null, location_city: "Hue", updated_at: "2026-05-01T00:00:00.000Z" },
      { id: M_CUSTOM, owner_id: BOB, title: "For a chosen few", caption: null, visibility: "custom", allowed_user_ids: [ALICE], hidden_user_ids: [], state: "published", trip_id: null, location_city: "Hue", updated_at: "2026-05-01T00:00:00.000Z" },
      { id: M_HIDDEN, owner_id: BOB, title: "Not for Alice", caption: null, visibility: "public", allowed_user_ids: [], hidden_user_ids: [ALICE], state: "published", trip_id: null, location_city: "Hue", updated_at: "2026-05-01T00:00:00.000Z" },
    ],
    blocks: [],
    highlight_resurfacing_preferences: [],
    highlight_projection_policies: [],
  };
}

function makeClient(db: Record<string, Row[]>, failing: ReadonlySet<string> = new Set()) {
  function from(table: string): Builder {
    const filters: Array<(r: Row) => boolean> = [];
    let limitN: number | null = null;
    const run = async (one: boolean): Promise<Result> => {
      if (failing.has(table)) return { data: null, error: { message: `injected failure on ${table}`, code: "XX000" } };
      let rows = (db[table] ?? []).filter((r) => filters.every((f) => f(r)));
      if (limitN !== null) rows = rows.slice(0, limitN);
      return { data: one ? (rows[0] ?? null) : rows, error: null };
    };
    const b: Builder = {
      select() { return b; },
      eq(c, v) { filters.push((r) => r[c] === v); return b; },
      neq(c, v) { filters.push((r) => r[c] !== v); return b; },
      in(c, vs) { filters.push((r) => vs.includes(r[c])); return b; },
      is(c, v) { filters.push((r) => (r[c] ?? null) === v); return b; },
      not(c, op, v) {
        if (op !== "is") throw new Error(`fake: not(${op}) is not implemented`);
        filters.push((r) => (r[c] ?? null) !== v);
        return b;
      },
      order() { return b; },
      limit(n) { limitN = n; return b; },
      maybeSingle() { return run(true); },
      single() { return run(true); },
      then(onF, onR) { return run(false).then(onF, onR); },
    };
    return b;
  }
  return { from };
}

async function card(objectType: "HIGHLIGHT" | "MEMORY", objectId: string, db = tables(), failing: ReadonlySet<string> = new Set()) {
  const client = makeClient(db, failing) as unknown as Parameters<typeof resolveShareProjections>[0];
  const [r] = await resolveShareProjections(client, ALICE, THREAD, [{ objectType, objectId }]);
  assert.ok(r, "one ref in, one card out");
  return r;
}

describe("Telegraph share card — a Highlight takes the single-Highlight read gate", () => {
  it("an unblocked, live, public Highlight resolves (intended case)", async () => {
    const r = await card("HIGHLIGHT", HL);
    assert.equal(r.available, true);
    assert.equal(r.projection?.title, "Sunset from the roof");
  });

  it("the OWNER blocked the viewer: unauthorized, and no caption or media URL", async () => {
    const db = tables();
    db.blocks = [{ blocker_id: BOB, blocked_id: ALICE }];
    const r = await card("HIGHLIGHT", HL, db);
    assert.equal(r.available, false);
    assert.equal(r.reason, "unauthorized");
    assert.equal(r.projection, null);
  });

  it("the VIEWER blocked the owner: unauthorized as well", async () => {
    const db = tables();
    db.blocks = [{ blocker_id: ALICE, blocked_id: BOB }];
    const r = await card("HIGHLIGHT", HL, db);
    assert.equal(r.available, false);
    assert.equal(r.reason, "unauthorized");
    assert.equal(r.projection, null);
  });

  it("an UNREADABLE blocks table is unknown, never a share", async () => {
    const r = await card("HIGHLIGHT", HL, tables(), new Set(["blocks"]));
    assert.equal(r.available, false);
    assert.equal(r.reason, "unknown");
    assert.equal(r.projection, null);
  });
});

describe("Telegraph share card — a Memory takes canReadMemory and a two-way block check", () => {
  it("an unblocked public Memory resolves (intended case)", async () => {
    const r = await card("MEMORY", M_PUBLIC);
    assert.equal(r.available, true);
    assert.equal(r.projection?.title, "The old harbour");
  });

  it("a `custom` Memory the viewer is allow-listed on still resolves (intended case)", async () => {
    const r = await card("MEMORY", M_CUSTOM);
    assert.equal(r.available, true);
    assert.equal(r.projection?.title, "For a chosen few");
  });

  it("an `only_me` Memory with a STALE allow-list entry is private — no title, no city", async () => {
    const r = await card("MEMORY", M_ONLY_ME_STALE);
    assert.equal(r.available, false);
    assert.equal(r.reason, "private");
    assert.equal(r.projection, null);
  });

  it("the owner blocked the viewer: unauthorized", async () => {
    const db = tables();
    db.blocks = [{ blocker_id: BOB, blocked_id: ALICE }];
    const r = await card("MEMORY", M_PUBLIC, db);
    assert.equal(r.reason, "unauthorized");
    assert.equal(r.projection, null);
  });

  it("the VIEWER blocked the owner: unauthorized (the direction this card used to skip)", async () => {
    const db = tables();
    db.blocks = [{ blocker_id: ALICE, blocked_id: BOB }];
    const r = await card("MEMORY", M_PUBLIC, db);
    assert.equal(r.available, false);
    assert.equal(r.reason, "unauthorized");
    assert.equal(r.projection, null);
  });

  it("an UNREADABLE blocks table is unknown", async () => {
    const r = await card("MEMORY", M_PUBLIC, tables(), new Set(["blocks"]));
    assert.equal(r.available, false);
    assert.equal(r.reason, "unknown");
  });

  it("a viewer on the hide list is refused", async () => {
    const r = await card("MEMORY", M_HIDDEN);
    assert.equal(r.available, false);
    assert.equal(r.projection, null);
  });
});
