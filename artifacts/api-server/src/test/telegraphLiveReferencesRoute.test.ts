/**
 * Sensing §12 through the REAL routes — POST /api/telegraph/threads/:id/
 * live-references and GET /api/telegraph/live-references/:messageId behind
 * `telegraph_live_references_enabled` (migration 2802, seeded FALSE), over
 * the fake PostgREST double the Map gateway suites use.
 *
 * OFF is the load-bearing case: with the flag absent or false both routes
 * answer feature_disabled and read nothing. ON: a non-member is refused
 * before anything is read; a share writes ONE card whose body is the
 * reference and whose human line carries no value; nothing to point at is a
 * named refusal and no card; a shared reference resolves against the current
 * state with changedSinceShare true / false, and NULL when live intelligence
 * is not servable; a card in a thread the viewer is not in reads as absent.
 *
 * fakeMapDb refuses writes by design; the POST cases wrap its client so the
 * `messages` table records the insert and answers RETURNING like PostgREST.
 */
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";

import telegraphLiveReferencesRouter from "../routes/telegraphLiveReferences.js";
import { _clearPromotedScopeCache } from "../lib/liveClaimRead.js";
import { _setTestClient } from "../lib/http.js";
import { LIVE_REFERENCE_MSG_SUBTYPE, LIVE_REFERENCE_MSG_TYPE, parseLiveReference, type LiveReference } from "../lib/liveReference.js";
import { startRouterApp, type FakeState, type ProjectionApp } from "./helpers/fakeMapDb.js";

const VIEWER = "77777777-aaaa-4aaa-8aaa-777777777777";
const STRANGER = "66666666-aaaa-4aaa-8aaa-666666666666";
const TOKEN = "live-ref-token";
const THREAD = "55555555-dddd-4ddd-8ddd-555555555555";
const OTHER_THREAD = "44444444-dddd-4ddd-8ddd-444444444444";
const PLACE_ID = "88888888-bbbb-4bbb-8bbb-888888888888";
const MESSAGE_ID = "33333333-eeee-4eee-8eee-333333333333";
const NOW = Date.now();
const iso = (offsetMinutes: number) => new Date(NOW + offsetMinutes * 60_000).toISOString();

const LIVE_GATES_OPEN = [
  { flag: "intel_live_label_crowd", enabled: true },
  { flag: "intel_claim_projection_crowd", enabled: true },
  { flag: "intel_capture_quick_signal", enabled: true },
  { flag: "intel_limited_live", enabled: true },
];
const ON = { flag: "telegraph_live_references_enabled", enabled: true };
const OFF = { flag: "telegraph_live_references_enabled", enabled: false };

function snapshot(over: Record<string, unknown> = {}) {
  return {
    id: `snap-${Math.random().toString(36).slice(2, 8)}`,
    subject_id: PLACE_ID,
    zone_id: null,
    claim_type: "crowd.level",
    value: { level: "packed" },
    confidence: 0.85,
    source_count: 30,
    observed_at: iso(-3),
    expires_at: iso(27),
    privacy_eligible: true,
    conflict_state: "none",
    source_class: "firsthand_unverified",
    computed_at: iso(-3),
    ...over,
  };
}

function world(flags: { flag: string; enabled: boolean }[] = [], over: FakeState = {}): FakeState {
  return {
    feature_flags: [...LIVE_GATES_OPEN, ...flags],
    places: [{ id: PLACE_ID, name: "Han Market", status: "active", merged_into_place_id: null }],
    intel_live_promoted_scopes: [{ scope_key: "|crowd.level" }, { scope_key: "|crowd.trajectory" }, { scope_key: "|vibe.state" }, { scope_key: "|queue.wait" }],
    intel_state_snapshots: [snapshot({ id: "snap-crowd" })],
    intel_state_snapshot_versions: [
      { id: "ver-old", subject_id: PLACE_ID, zone_id: "", claim_type: "crowd.level", value: { level: "busy" }, privacy_eligible: true, observed_at: iso(-41), generated_at: iso(-40) },
      { id: "ver-now", subject_id: PLACE_ID, zone_id: "", claim_type: "crowd.level", value: { level: "packed" }, privacy_eligible: true, observed_at: iso(-4), generated_at: iso(-3) },
    ],
    message_thread_members: [{ thread_id: THREAD, user_id: VIEWER, left_at: null }],
    messages: [],
    ...over,
  };
}

/** A stored card, as the route would have written it. */
function storedCard(reference: LiveReference, over: Record<string, unknown> = {}) {
  return {
    id: MESSAGE_ID,
    thread_id: THREAD,
    sender_id: VIEWER,
    body: JSON.stringify(reference),
    msg_type: LIVE_REFERENCE_MSG_TYPE,
    subtype: LIVE_REFERENCE_MSG_SUBTYPE,
    created_at: iso(-10),
    deleted_at: null,
    ...over,
  };
}

function sharedReference(over: Partial<LiveReference> = {}): LiveReference {
  return {
    type: "live_reference",
    schemaVersion: 1,
    kind: "experience_state",
    subject: { type: "place", id: PLACE_ID, name: "Han Market" },
    claims: [
      {
        claimType: "crowd.level",
        snapshotId: "snap-crowd",
        versionId: "ver-now",
        value: "packed",
        observedAt: iso(-12),
        validUntil: iso(18),
        state: "live",
        band: "live",
        sourceClass: "firsthand_unverified",
        conflictState: "none",
      },
    ],
    moment: null,
    truth: { truthClass: "corroborated", confidence: "live", freshness: "live", coverage: "many", provenance: ["sensing_live_v1"] },
    sharedAt: iso(-10),
    note: null,
    text: "Live state of Han Market",
    ...over,
  };
}

interface Inserted {
  rows: Array<Record<string, unknown>>;
}

/** Wrap the fake so `messages` records inserts and answers RETURNING; every other table is the fake's. */
function writableMessages(app: ProjectionApp, inserted: Inserted, opts: { failInsert?: boolean } = {}) {
  const base = app.client;
  const wrapped = {
    ...base,
    from(table: string) {
      const q = base.from(table);
      if (table !== "messages") return q;
      return {
        ...q,
        insert(row: Record<string, unknown>) {
          return {
            select() {
              return {
                single: async () => {
                  if (opts.failInsert) return { data: null, error: { code: "42501", message: "denied" } };
                  const stored = { id: MESSAGE_ID, created_at: iso(0), ...row };
                  inserted.rows.push(stored);
                  return { data: { id: stored.id, created_at: stored.created_at }, error: null };
                },
              };
            },
          };
        },
      };
    },
  };
  _setTestClient(wrapped, true);
}

interface ShareBody {
  ok?: boolean;
  error?: string;
  refusal?: string;
  messageId?: string;
  reference?: LiveReference;
  versionsPinned?: boolean;
}
interface ResolveBody {
  ok?: boolean;
  error?: string;
  refusal?: string;
  reference?: LiveReference;
  current?: { claims: Array<{ claimType: string; value: unknown }> } | null;
  comparison?: { readable: boolean; changedSinceShare: boolean | null; refusal: string | null; claims: Array<{ claimType: string; change: string }>; momentStillCurrent: boolean | null };
}

describe("Telegraph live references — the routes", () => {
  let app: ProjectionApp | null = null;
  afterEach(async () => {
    _clearPromotedScopeCache();
    if (app) await app.close();
    app = null;
  });

  async function post(thread: string, body: unknown, token = TOKEN) {
    const r = await fetch(`${app!.baseUrl}/api/telegraph/threads/${thread}/live-references`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: r.status, body: (await r.json()) as ShareBody };
  }
  async function get(messageId: string, token = TOKEN) {
    const r = await fetch(`${app!.baseUrl}/api/telegraph/live-references/${messageId}`, { headers: { Authorization: `Bearer ${token}` } });
    return { status: r.status, body: (await r.json()) as ResolveBody };
  }

  it("OFF: flag absent → both routes answer feature_disabled and write nothing", async () => {
    const inserted: Inserted = { rows: [] };
    app = await startRouterApp(telegraphLiveReferencesRouter, world([]), { token: TOKEN, userId: VIEWER });
    writableMessages(app, inserted);
    const p = await post(THREAD, { subjectId: PLACE_ID, kind: "experience_state" });
    assert.equal(p.status, 404);
    assert.equal(p.body.error, "feature_disabled");
    const g = await get(MESSAGE_ID);
    assert.equal(g.status, 404);
    assert.equal(g.body.error, "feature_disabled");
    assert.equal(inserted.rows.length, 0);
  });

  it("OFF: flag false → the same", async () => {
    app = await startRouterApp(telegraphLiveReferencesRouter, world([OFF]), { token: TOKEN, userId: VIEWER });
    const p = await post(THREAD, { subjectId: PLACE_ID, kind: "experience_state" });
    assert.equal(p.body.error, "feature_disabled");
  });

  it("unauthenticated is refused before the flag is read", async () => {
    app = await startRouterApp(telegraphLiveReferencesRouter, world([ON]), { token: TOKEN, userId: VIEWER });
    const p = await post(THREAD, { subjectId: PLACE_ID, kind: "experience_state" }, "wrong");
    assert.equal(p.status, 401);
  });

  it("ON: a non-member of the thread is forbidden and nothing is written", async () => {
    const inserted: Inserted = { rows: [] };
    app = await startRouterApp(telegraphLiveReferencesRouter, world([ON]), { token: TOKEN, userId: STRANGER });
    writableMessages(app, inserted);
    const p = await post(THREAD, { subjectId: PLACE_ID, kind: "experience_state" });
    assert.equal(p.status, 403);
    assert.equal(p.body.error, "forbidden");
    assert.equal(inserted.rows.length, 0);
  });

  it("ON: a member who LEFT the thread is not a member", async () => {
    const inserted: Inserted = { rows: [] };
    app = await startRouterApp(
      telegraphLiveReferencesRouter,
      world([ON], { message_thread_members: [{ thread_id: THREAD, user_id: VIEWER, left_at: iso(-60) }] }),
      { token: TOKEN, userId: VIEWER },
    );
    writableMessages(app, inserted);
    const p = await post(THREAD, { subjectId: PLACE_ID, kind: "experience_state" });
    assert.equal(p.status, 403);
    assert.equal(inserted.rows.length, 0);
  });

  it("ON: a share writes ONE card whose body is the reference, pinned to the version, and its line carries no value", async () => {
    const inserted: Inserted = { rows: [] };
    app = await startRouterApp(telegraphLiveReferencesRouter, world([ON]), { token: TOKEN, userId: VIEWER });
    writableMessages(app, inserted);
    const p = await post(THREAD, { subjectId: PLACE_ID, kind: "experience_state", note: "meet here?" });
    assert.equal(p.status, 201, JSON.stringify(p.body));
    assert.equal(p.body.ok, true);
    assert.equal(p.body.messageId, MESSAGE_ID);
    assert.equal(p.body.versionsPinned, true);
    assert.equal(inserted.rows.length, 1);
    const row = inserted.rows[0]!;
    assert.equal(row.thread_id, THREAD);
    assert.equal(row.sender_id, VIEWER);
    assert.equal(row.msg_type, "card");
    assert.equal(row.subtype, "live_reference");
    const stored = parseLiveReference(String(row.body));
    assert.ok(stored, "the body is a reference this module can read back");
    assert.equal(stored.kind, "experience_state");
    assert.equal(stored.subject.id, PLACE_ID);
    assert.equal(stored.subject.name, "Han Market");
    assert.equal(stored.claims.length, 1);
    assert.equal(stored.claims[0]!.snapshotId, "snap-crowd");
    assert.equal(stored.claims[0]!.versionId, "ver-now");
    assert.equal(stored.claims[0]!.value, "packed");
    assert.equal(stored.note, "meet here?");
    assert.equal(stored.text, "Live state of Han Market");
    assert.equal(stored.text.includes("packed"), false);
    assert.deepEqual(p.body.reference, stored);
  });

  it("ON: the card carries nothing person-shaped and no count — S89, no longer vacuous", async () => {
    const inserted: Inserted = { rows: [] };
    app = await startRouterApp(telegraphLiveReferencesRouter, world([ON]), { token: TOKEN, userId: VIEWER });
    writableMessages(app, inserted);
    const p = await post(THREAD, { subjectId: PLACE_ID, kind: "experience_state" });
    assert.equal(p.status, 201);
    const body = String(inserted.rows[0]!.body);
    for (const forbidden of ["distinct_actors", "distinctActors", "source_count", "sourceCount", "sourceCountBucket", "contributor", "actor", "device", "user_id", "userId", "count"]) {
      assert.equal(body.includes(`"${forbidden}"`), false, `body must not carry ${forbidden}`);
    }
    assert.equal(body.includes(VIEWER), false, "the sender is the row's sender_id, never inside the reference");
  });

  it("ON: nothing to point at is a named refusal, and no card", async () => {
    const inserted: Inserted = { rows: [] };
    app = await startRouterApp(telegraphLiveReferencesRouter, world([ON]), { token: TOKEN, userId: VIEWER });
    writableMessages(app, inserted);
    const p = await post(THREAD, { subjectId: PLACE_ID, kind: "safety_notice" });
    assert.equal(p.status, 200);
    assert.equal(p.body.ok, false);
    assert.equal(p.body.refusal, "nothing_to_reference");
    assert.equal(inserted.rows.length, 0);
  });

  it("ON: a world_moment share carries the transition the record evidences", async () => {
    const inserted: Inserted = { rows: [] };
    app = await startRouterApp(telegraphLiveReferencesRouter, world([ON]), { token: TOKEN, userId: VIEWER });
    writableMessages(app, inserted);
    const p = await post(THREAD, { subjectId: PLACE_ID, kind: "world_moment" });
    assert.equal(p.status, 201, JSON.stringify(p.body));
    assert.deepEqual(p.body.reference?.moment && { kind: p.body.reference.moment.kind, from: p.body.reference.moment.from, to: p.body.reference.moment.to }, {
      kind: "crowd_shift",
      from: "busy",
      to: "packed",
    });
    assert.equal(p.body.reference?.text, "Live moment of Han Market");
  });

  it("ON: a world_moment with no change on record is nothing_to_reference", async () => {
    const inserted: Inserted = { rows: [] };
    app = await startRouterApp(telegraphLiveReferencesRouter, world([ON], { intel_state_snapshot_versions: [] }), { token: TOKEN, userId: VIEWER });
    writableMessages(app, inserted);
    const p = await post(THREAD, { subjectId: PLACE_ID, kind: "world_moment" });
    assert.equal(p.body.refusal, "nothing_to_reference");
    assert.equal(inserted.rows.length, 0);
  });

  it("ON: live intelligence not servable → a refusal, not a card of stale prose", async () => {
    const inserted: Inserted = { rows: [] };
    const closed = world([ON]);
    closed.feature_flags = [ON, { flag: "intel_live_label_crowd", enabled: false }];
    app = await startRouterApp(telegraphLiveReferencesRouter, closed, { token: TOKEN, userId: VIEWER });
    writableMessages(app, inserted);
    const p = await post(THREAD, { subjectId: PLACE_ID, kind: "experience_state" });
    assert.equal(p.status, 200);
    assert.equal(p.body.refusal, "live_intelligence_unavailable");
    assert.equal(inserted.rows.length, 0);
  });

  it("ON: an unknown or inactive place is not_found; a bad kind is invalid_payload", async () => {
    app = await startRouterApp(telegraphLiveReferencesRouter, world([ON], { places: [{ id: PLACE_ID, name: "Han Market", status: "archived" }] }), {
      token: TOKEN,
      userId: VIEWER,
    });
    const p = await post(THREAD, { subjectId: PLACE_ID, kind: "experience_state" });
    assert.equal(p.status, 404);
    const q = await post(THREAD, { subjectId: PLACE_ID, kind: "opportunity" });
    assert.equal(q.status, 400);
    assert.equal(q.body.error, "invalid_payload");
  });

  it("ON: a refused write is db_error, never a success with no card", async () => {
    const inserted: Inserted = { rows: [] };
    app = await startRouterApp(telegraphLiveReferencesRouter, world([ON]), { token: TOKEN, userId: VIEWER });
    writableMessages(app, inserted, { failInsert: true });
    const p = await post(THREAD, { subjectId: PLACE_ID, kind: "experience_state" });
    assert.equal(p.status, 500);
    assert.equal(p.body.error, "db_error");
  });

  it("GET: an unchanged state resolves with changedSinceShare false and the current claims", async () => {
    app = await startRouterApp(telegraphLiveReferencesRouter, world([ON], { messages: [storedCard(sharedReference())] }), { token: TOKEN, userId: VIEWER });
    const g = await get(MESSAGE_ID);
    assert.equal(g.status, 200, JSON.stringify(g.body));
    assert.equal(g.body.ok, true);
    assert.equal(g.body.reference?.subject.id, PLACE_ID);
    assert.equal(g.body.comparison?.readable, true);
    assert.equal(g.body.comparison?.changedSinceShare, false);
    assert.equal(g.body.comparison?.claims[0]?.change, "reaffirmed");
    assert.equal(g.body.current?.claims[0]?.claimType, "crowd.level");
  });

  it("GET: a changed state resolves with changedSinceShare true", async () => {
    app = await startRouterApp(
      telegraphLiveReferencesRouter,
      world([ON], { messages: [storedCard(sharedReference())], intel_state_snapshots: [snapshot({ id: "snap-crowd", value: { level: "quiet" } })] }),
      { token: TOKEN, userId: VIEWER },
    );
    const g = await get(MESSAGE_ID);
    assert.equal(g.body.comparison?.changedSinceShare, true);
    assert.equal(g.body.comparison?.claims[0]?.change, "changed");
  });

  it("GET: live intelligence not servable → changedSinceShare NULL with the refusal, never false", async () => {
    const closed = world([ON], { messages: [storedCard(sharedReference())] });
    closed.feature_flags = [ON, { flag: "intel_live_label_crowd", enabled: false }];
    app = await startRouterApp(telegraphLiveReferencesRouter, closed, { token: TOKEN, userId: VIEWER });
    const g = await get(MESSAGE_ID);
    assert.equal(g.status, 200);
    assert.equal(g.body.ok, true);
    assert.equal(g.body.comparison?.readable, false);
    assert.equal(g.body.comparison?.changedSinceShare, null);
    assert.equal(g.body.comparison?.refusal, "live_intelligence_unavailable");
    assert.equal(g.body.current, null);
  });

  it("GET: a card in a thread the viewer is not in reads as absent, like a deleted or foreign card", async () => {
    app = await startRouterApp(
      telegraphLiveReferencesRouter,
      world([ON], {
        messages: [
          storedCard(sharedReference(), { thread_id: OTHER_THREAD }),
          storedCard(sharedReference(), { id: "22222222-eeee-4eee-8eee-222222222222", deleted_at: iso(-1) }),
          storedCard(sharedReference(), { id: "11111111-eeee-4eee-8eee-111111111111", subtype: "hidden_gem" }),
        ],
      }),
      { token: TOKEN, userId: VIEWER },
    );
    assert.equal((await get(MESSAGE_ID)).status, 404);
    assert.equal((await get("22222222-eeee-4eee-8eee-222222222222")).status, 404);
    assert.equal((await get("11111111-eeee-4eee-8eee-111111111111")).status, 404);
    assert.equal((await get("00000000-eeee-4eee-8eee-000000000000")).status, 404);
  });

  it("GET: a card whose body is not a reference is a named refusal", async () => {
    app = await startRouterApp(telegraphLiveReferencesRouter, world([ON], { messages: [storedCard(sharedReference(), { body: "{\"type\":\"junk\"}" })] }), {
      token: TOKEN,
      userId: VIEWER,
    });
    const g = await get(MESSAGE_ID);
    assert.equal(g.status, 200);
    assert.equal(g.body.ok, false);
    assert.equal(g.body.refusal, "malformed_reference");
  });
});
