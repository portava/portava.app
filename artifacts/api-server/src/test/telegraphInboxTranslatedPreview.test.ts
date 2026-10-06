/**
 * Telegraph §18.2 / census T242 — the INBOX preview of a translated message.
 *
 * Both chat screens show the original alongside a translation the server
 * cannot call certain (T242). The inbox preview showed the translation ALONE,
 * with no sign it was a translation: `GET /me/threads` swapped in
 * `translated_body` by hand and dropped everything `buildDisplayFields` knows.
 * It now asks the same helper, from the same row, and carries `translated` and
 * `showOriginalAlongside` on `lastMessagePreview`.
 *
 * No `confidence` is read — migration 2991 is applied to no database and the
 * read would fail with 42703 — so every translated preview today has no
 * reading, which the helper treats as not-high: the original is shown.
 *
 * Run: node --import tsx/esm --test src/test/telegraphInboxTranslatedPreview.test.ts
 */
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { _setTestClient } from "../lib/http.js";
import messagingRouter from "../routes/messaging.js";
import {
  makeFakeClient,
  startRouter,
  call,
  resetFakeIds,
  type InjectedError,
  type RouterHarness,
} from "./telegraphCertificationHarness.js";

const ALICE = "aaaaaaaa-0000-4000-8000-000000000001";
const BOB = "bbbbbbbb-0000-4000-8000-000000000002";
const THREAD = "00000000-0000-4000-8000-00000000000a";
const TRIP = "00000000-0000-4000-8000-0000000000b1";
const MSG = "11111111-0000-4000-8000-000000000001";
const DOWN = { message: "permission denied for relation", code: "42501" };

function seed(over: { sender?: string; translations?: Record<string, unknown>[] } = {}): Record<string, any[]> {
  return {
    feature_flags: [],
    profiles: [
      { id: ALICE, handle: "alice", name: "Alice", show_name: true },
      { id: BOB, handle: "bob", name: "Bob", show_name: true },
    ],
    blocks: [],
    message_threads: [
      {
        id: THREAD, thread_type: "trip", trip_id: TRIP, circle_owner_id: null,
        title: "Cebu crew", status: "active", is_e2ee: false,
        created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-03-11T00:00:00.000Z",
        last_message_at: "2026-03-11T00:00:00.000Z",
      },
    ],
    message_thread_members: [ALICE, BOB].map((u) => ({
      thread_id: THREAD, user_id: u, role: "member",
      joined_at: "2026-01-01T00:00:00.000Z", left_at: null, last_read_at: null,
      muted_at: null, archived_at: null, visible_from_at: null,
    })),
    messages: [
      {
        id: MSG, thread_id: THREAD, sender_id: over.sender ?? ALICE,
        body: "nos vemos en el muelle", created_at: "2026-03-11T00:00:00.000Z",
        deleted_at: null, edited_at: null, original_language: "es",
        msg_type: "text", subtype: null, media_url: null, media_type: null,
        media_thumbnail_url: null, media_duration_seconds: null, reply_to_id: null,
      },
    ],
    message_translations: over.translations ?? [],
    trips: [{ id: TRIP, title: "Cebu", destination_city: "Cebu" }],
    trip_members: [
      { trip_id: TRIP, user_id: ALICE, role: "owner" },
      { trip_id: TRIP, user_id: BOB, role: "member" },
    ],
    message_requests: [],
  };
}

const translatedForBob = (status: string, body: string | null = "see you at the pier") => ({
  message_id: MSG, recipient_id: BOB, source_language: "es", target_language: "en",
  translated_body: body, status,
});

let harness: RouterHarness;
function use(state: Record<string, any[]>, errors?: Record<string, InjectedError>) {
  _setTestClient(makeFakeClient(state, errors ? { errors } : undefined), true);
}
async function preview(asUser = BOB) {
  const r = await call(harness.base, "GET", "/me/threads", asUser);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body.threads[0].lastMessagePreview;
}

before(async () => { harness = await startRouter(messagingRouter); });
after(async () => { await harness.close(); });
beforeEach(() => resetFakeIds());

describe("§18.2 T242 — a translated inbox preview says it is a translation and keeps its original", () => {
  it("an incoming TRANSLATED message: the translation is shown, marked translated, with the original alongside", async () => {
    use(seed({ translations: [translatedForBob("translated")] }));
    const p = await preview();
    assert.equal(p.displayBody, "see you at the pier");
    assert.equal(p.body, "nos vemos en el muelle");
    assert.equal(p.translated, true);
    assert.equal(p.showOriginalAlongside, true, "no confidence reading is not certainty");
  });

  it("the sender's own message is never shown as a translation", async () => {
    use(seed({ sender: BOB, translations: [translatedForBob("translated")] }));
    const p = await preview(BOB);
    assert.equal(p.displayBody, "nos vemos en el muelle");
    assert.equal(p.translated, false);
    assert.equal(p.showOriginalAlongside, false);
  });

  it("no translation row: the original, not marked", async () => {
    use(seed());
    const p = await preview();
    assert.equal(p.displayBody, "nos vemos en el muelle");
    assert.equal(p.translated, false);
    assert.equal(p.showOriginalAlongside, false);
  });

  it("a FAILED or PENDING translation shows the original and does not claim to be one", async () => {
    for (const status of ["failed", "pending"]) {
      use(seed({ translations: [translatedForBob(status)] }));
      const p = await preview();
      assert.equal(p.displayBody, "nos vemos en el muelle", status);
      assert.equal(p.translated, false, status);
    }
  });

  it("an unreadable translations table still says so (T344), and claims no translation", async () => {
    use(seed(), { message_translations: DOWN });
    const p = await preview();
    assert.equal(p.previewTranslationStatus, "failed");
    assert.equal(p.translated, false);
  });

  it("the preview read never asks for `confidence` (2991 is applied nowhere — it would be a 42703)", () => {
    const src = readFileSync(new URL("../routes/messaging.ts", import.meta.url), "utf8");
    const at = src.indexOf("'message_id, translated_body, status, source_language, target_language'");
    assert.ok(at > 0, "the preview's translations select was not found");
    const line = src.slice(src.lastIndexOf("\n", at), src.indexOf("\n", at));
    assert.equal(/confidence'/.test(line.split("//")[0]!), false);
  });
});
