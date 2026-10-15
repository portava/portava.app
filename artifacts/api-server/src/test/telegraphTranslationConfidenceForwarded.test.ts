import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { _setTestClient } from "../lib/http.js";
import messagingRouter from "../routes/messaging.js";
import groupChatRouter from "../routes/groupChat.js";
import { __resetConfidenceColumnProbe } from "../services/messageTranslation.js";
import {
  makeFakeClient,
  startRouter,
  call,
  resetFakeIds,
  type FakeClient,
  type RouterHarness,
} from "./telegraphCertificationHarness.js";

const ALICE = "aaaaaaaa-0000-4000-8000-000000000001";
const BOB = "bbbbbbbb-0000-4000-8000-000000000002";
const THREAD = "00000000-0000-4000-8000-00000000000a";
const TRIP_THREAD = "00000000-0000-4000-8000-00000000000b";
const TRIP = "77777777-0000-4000-8000-000000000007";
const MSG = "11111111-0000-4000-8000-000000000001";
const TRIP_MSG = "22222222-0000-4000-8000-000000000002";

const ORIGINAL = "nos vemos en el muelle a las ocho";
const TRANSLATED = "see you at the pier at eight";

function member(thread: string, user: string): Record<string, unknown> {
  return {
    thread_id: thread, user_id: user, role: "member",
    joined_at: "2026-01-01T00:00:00.000Z", left_at: null,
    last_read_at: null, muted_at: null, archived_at: null, visible_from_at: null,
  };
}

function textMsg(id: string, thread: string): Record<string, unknown> {
  return {
    id, thread_id: thread, sender_id: ALICE, body: ORIGINAL,
    created_at: "2026-03-11T00:00:00.000Z", deleted_at: null, edited_at: null,
    original_language: "es", msg_type: "text", subtype: null,
    media_url: null, media_type: null, media_thumbnail_url: null,
    media_duration_seconds: null, reply_to_id: null,
  };
}

function translation(messageId: string, confidence: "low" | "high" | null): Record<string, unknown> {
  return {
    message_id: messageId, recipient_id: BOB, source_language: "es", target_language: "en",
    translated_body: TRANSLATED, status: "translated", confidence,
  };
}

function seed(confidence: "low" | "high" | null): Record<string, Array<Record<string, unknown>>> {
  return {
    feature_flags: [],
    profiles: [
      { id: ALICE, handle: "alice", name: "Alice" },
      { id: BOB, handle: "bob", name: "Bob" },
    ],
    blocks: [],
    trips: [{ id: TRIP, title: "Cebu", destination_city: "Cebu", owner_id: ALICE }],
    trip_members: [
      { trip_id: TRIP, user_id: ALICE, role: "owner", status: "accepted" },
      { trip_id: TRIP, user_id: BOB, role: "member", status: "accepted" },
    ],
    message_threads: [
      {
        id: THREAD, thread_type: "direct", trip_id: null, circle_owner_id: null, title: null,
        status: "active", is_e2ee: false, created_at: "2026-01-01T00:00:00.000Z",
        updated_at: "2026-03-11T00:00:00.000Z", last_message_at: "2026-03-11T00:00:00.000Z",
      },
      {
        id: TRIP_THREAD, thread_type: "trip", trip_id: TRIP, circle_owner_id: null, title: "Cebu",
        status: "active", is_e2ee: false, created_at: "2026-01-01T00:00:00.000Z",
        updated_at: "2026-03-11T00:00:00.000Z", last_message_at: "2026-03-11T00:00:00.000Z",
      },
    ],
    message_thread_members: [
      member(THREAD, ALICE), member(THREAD, BOB),
      member(TRIP_THREAD, ALICE), member(TRIP_THREAD, BOB),
    ],
    messages: [textMsg(MSG, THREAD), textMsg(TRIP_MSG, TRIP_THREAD)],
    message_translations: [translation(MSG, confidence), translation(TRIP_MSG, confidence)],
  };
}

/**
 * A database without migration 2991: selecting `confidence` is refused the way
 * PostgREST refuses an undefined column. Every other select on the table — and
 * every other table — is the ordinary fake.
 */
function withoutConfidenceColumn(c: FakeClient, refusals: string[]): FakeClient {
  const from = c.from.bind(c);
  return {
    ...c,
    from(table: string) {
      const q = from(table);
      if (table !== "message_translations") return q;
      const select = q.select.bind(q);
      q.select = (sel?: string, o?: unknown) => {
        if (typeof sel === "string" && /\bconfidence\b/.test(sel)) {
          refusals.push(sel);
          type Refusal = { data: null; error: { code: string; message: string } };
          type Chain = {
            in: () => Chain;
            eq: () => Chain;
            then: (resolve: (v: Refusal) => unknown, reject?: (e: unknown) => unknown) => Promise<unknown>;
          };
          const refused: Chain = {
            in: () => refused,
            eq: () => refused,
            then: (resolve, reject) =>
              Promise.resolve({
                data: null,
                error: { code: "42703", message: "column message_translations.confidence does not exist" },
              }).then(resolve, reject),
          };
          return refused;
        }
        return select(sel, o);
      };
      return q;
    },
  };
}

let dm: RouterHarness;
let trip: RouterHarness;

function use(c: FakeClient): FakeClient {
  _setTestClient(c, true);
  return c;
}

before(async () => {
  dm = await startRouter(messagingRouter);
  trip = await startRouter(groupChatRouter);
});
after(async () => {
  await dm.close();
  await trip.close();
});
beforeEach(() => {
  resetFakeIds();
  __resetConfidenceColumnProbe();
});

type WireMessage = Record<string, unknown> & { id: string };
function incoming(body: unknown, id: string): WireMessage {
  const b = (body ?? {}) as { messages?: WireMessage[]; items?: WireMessage[] };
  const list: WireMessage[] = b.messages ?? b.items ?? [];
  const m = list.find((x) => x.id === id);
  assert.ok(m, `message ${id} missing from ${JSON.stringify(body).slice(0, 400)}`);
  return m;
}

describe("§18.2 T242 — GET /threads/:threadId/messages forwards the show-both decision", () => {
  it("legacy LOW detection confidence arrives as unknown quality with both bodies", async () => {
    use(makeFakeClient(seed("low")));
    const r = await call(dm.base, "GET", `/threads/${THREAD}/messages`, BOB);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const m = incoming(r.body, MSG);
    assert.equal(m.translationStatus, "translated");
    assert.equal(m.translationConfidence, null);
    assert.equal(m.showOriginalAlongside, true);
    assert.equal(m.displayBody, TRANSLATED);
    assert.equal(m.originalBody, ORIGINAL);
  });

  it("legacy HIGH detection confidence cannot hide the original in a DM", async () => {
    use(makeFakeClient(seed("high")));
    const r = await call(dm.base, "GET", `/threads/${THREAD}/messages`, BOB);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const m = incoming(r.body, MSG);
    assert.equal(m.translationConfidence, null);
    assert.equal(m.showOriginalAlongside, true);
    assert.equal(m.originalBody, ORIGINAL);
    assert.equal(m.displayBody, TRANSLATED);
  });

  it("THE POINT: without 2991 the read falls back by name — still translated, NOT failed, shown with the original", async () => {
    const refusals: string[] = [];
    const c = use(withoutConfidenceColumn(makeFakeClient(seed(null)), refusals));
    const r = await call(dm.base, "GET", `/threads/${THREAD}/messages`, BOB);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(refusals.length, 1, "the reader must ASK for confidence once, then fall back");
    const m = incoming(r.body, MSG);
    assert.equal(m.translationStatus, "translated", "a missing column is not an unreadable table");
    assert.equal(m.translationConfidence, null);
    assert.equal(m.showOriginalAlongside, true, "an unrecorded confidence is not a high one");
    assert.equal(m.displayBody, TRANSLATED);
    const fallback = c._observed.selects.filter((s) => s.table === "message_translations");
    assert.ok(fallback.some((s) => !/confidence/.test(s.sel)), "the fallback select names the columns without confidence");
  });

  it("the 2991-absent fact is learned once per process: a second read does not ask again", async () => {
    const refusals: string[] = [];
    use(withoutConfidenceColumn(makeFakeClient(seed(null)), refusals));
    await call(dm.base, "GET", `/threads/${THREAD}/messages`, BOB);
    await call(dm.base, "GET", `/threads/${THREAD}/messages`, BOB);
    assert.equal(refusals.length, 1);
  });

  it("CONTROL: any OTHER read error is still the failed-read arm, never a quiet original", async () => {
    use(makeFakeClient(seed("low"), {
      errors: { message_translations: { code: "42501", message: "permission denied for table message_translations", ops: ["select"] } },
    }));
    const r = await call(dm.base, "GET", `/threads/${THREAD}/messages`, BOB);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const m = incoming(r.body, MSG);
    assert.equal(m.translationStatus, "failed");
    assert.equal(m.showOriginalAlongside, false);
  });

  it("CONTROL: the sender never gets the flag for their own message", async () => {
    use(makeFakeClient(seed("low")));
    const r = await call(dm.base, "GET", `/threads/${THREAD}/messages`, ALICE);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const m = incoming(r.body, MSG);
    assert.equal(m.showOriginalAlongside, false);
    assert.equal(m.displayBody, ORIGINAL);
  });
});

describe("§18.2 T242 — GET /trips/:tripId/chat forwards the same decision", () => {
  it("legacy LOW detection confidence arrives as unknown quality in the trip chat", async () => {
    use(makeFakeClient(seed("low")));
    const r = await call(trip.base, "GET", `/trips/${TRIP}/chat`, BOB);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const m = incoming(r.body, TRIP_MSG);
    assert.equal(m.translationConfidence, null);
    assert.equal(m.showOriginalAlongside, true);
    assert.equal(m.displayBody, TRANSLATED);
    assert.equal(m.originalBody, ORIGINAL);
  });

  it("legacy HIGH detection confidence cannot hide the original in a trip chat", async () => {
    use(makeFakeClient(seed("high")));
    const response = await call(trip.base, "GET", `/trips/${TRIP}/chat`, BOB);
    assert.equal(response.status, 200, JSON.stringify(response.body));
    const message = incoming(response.body, TRIP_MSG);
    assert.equal(message.translationConfidence, null);
    assert.equal(message.showOriginalAlongside, true);
    assert.equal(message.displayBody, TRANSLATED);
    assert.equal(message.originalBody, ORIGINAL);
  });

  it("THE POINT: without 2991 the trip chat still shows the translation, with the original alongside", async () => {
    const refusals: string[] = [];
    use(withoutConfidenceColumn(makeFakeClient(seed(null)), refusals));
    const r = await call(trip.base, "GET", `/trips/${TRIP}/chat`, BOB);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const m = incoming(r.body, TRIP_MSG);
    assert.equal(m.translationStatus, "translated");
    assert.equal(m.showOriginalAlongside, true);
  });
});
