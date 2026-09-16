/**
 * VERIFICATION LANE V3 — FLOW 1: A VOICE MESSAGE, RECORD TO PLAYBACK.
 *
 * `src/test/telegraphVoice.test.ts` proves each LEG of the voice feature in
 * isolation: the sniffer, the upload policy, the payload schema, the row
 * shape, and the send route's gates. What it never does is put two legs
 * together. This file is the JOIN — the hops a traveller's voice note actually
 * makes, driven through THREE REAL ROUTERS mounted on ONE express app over ONE
 * shared in-memory PostgREST-shaped store, so a row written by one router is
 * read by the next exactly as it would be through a database:
 *
 *   1. POST /api/threads/:id/voice              (routes/telegraphVoice.ts)
 *   2. GET  /api/threads/:id/messages           (routes/messaging.ts)
 *   3. GET  /api/threads/:id/drawer?tab=VOICE   (routes/telegraphKinds.ts)
 *   4. the client's own parser, run against the payload the thread read hands
 *      it, because that is the last hop before a bubble renders.
 *
 * WHY A SEPARATE FILE AND NOT MORE CASES IN telegraphVoice.test.ts. That suite
 * mounts ONE router. The defects this file looks for cannot exist inside one
 * router: they are the seams where the telegraph lane's writer meets the
 * messaging lane's reader, and a suite that mounts only the writer cannot see
 * them.
 *
 * ── WHAT IS NOT EXERCISED, STATED RATHER THAN IMPLIED BY ITS ABSENCE ────────
 *
 * MIGRATION 2989 IS APPLIED TO NO DATABASE. `messages.media_type` refuses the
 * value `audio` on every real deployment of this tree. The store below is a
 * JavaScript object; it enforces no CHECK constraint, so every row this file
 * writes would be REFUSED in production today. Nothing here is evidence that
 * voice messages work on a real database — it is evidence that these code
 * paths agree with each other, which is a different and smaller claim. The
 * named refusal that fires when 2989 is missing is already pinned in
 * telegraphVoice.test.ts and is not re-pinned here.
 *
 * THE UPLOAD ROUTE IS NOT DRIVEN over HTTP (it writes to Supabase Storage).
 * Its OUTPUT CONTRACT is stated here as a constant and fed to the send route,
 * which is the seam between them and is checkable without a bucket.
 *
 * THE CLIENT IS NOT RENDERED here. `travel-buddy-standalone/src/features/
 * telegraph/__tests__/voice.component.test.tsx` renders the player and the
 * recorder, and `.../verifyFlowCrossTreeVocabulary.component.test.tsx` checks
 * that the two trees duplicated constants still agree. This file asserts the
 * payload those halves are given.
 *
 * SHOWN RED BEFORE GREEN — see the mutation log at the foot of this file.
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx/esm --test src/test/verifyFlowVoiceEndToEnd.test.ts
 */
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import express from "express";

import { _setTestClient } from "../lib/http.js";
import telegraphVoiceRouter from "../routes/telegraphVoice.js";
import telegraphKindsRouter from "../routes/telegraphKinds.js";
import messagingRouter from "../routes/messaging.js";
import { makeFakeClient, resetFakeIds, type FakeClient } from "./telegraphCertificationHarness.js";
import { VOICE_MAX_DURATION_SECONDS, WAVEFORM_MAX_PEAKS } from "../services/telegraph/voice.js";
import { ALLOWED_VOICE_MIME } from "../lib/mediaPipeline.js";
import { DRAWER_TABS } from "../services/telegraph/messageKinds.js";

const ALICE = "aaaaaaaa-0000-4000-8000-000000000001";
const BOB = "bbbbbbbb-0000-4000-8000-000000000002";
const CAROL = "cccccccc-0000-4000-8000-000000000003";
const THREAD = "dddddddd-0000-4000-8000-00000000000d";

/**
 * The upload route's RESPONSE, verbatim from `routes/telegraphVoice.ts`'s
 * `res.status(201).json({...})`. The send route is driven with THIS and not
 * with a hand-rolled payload, so a change to either side that breaks the
 * handshake reddens here rather than in production on the first recording.
 */
const UPLOAD_RESPONSE = {
  url: `post-media/${ALICE}/voice/1758000000000.m4a`,
  path: `${ALICE}/voice/1758000000000.m4a`,
  mimeType: "audio/mp4",
  sizeBytes: 98_304,
  maxDurationSeconds: VOICE_MAX_DURATION_SECONDS,
  maxWaveformPeaks: WAVEFORM_MAX_PEAKS,
} as const;

/** What `VoiceRecorderSheet#onSend` builds out of the upload response. */
function recorderPayload(over: Record<string, unknown> = {}) {
  return {
    url: UPLOAD_RESPONSE.url,
    durationSeconds: 37,
    waveform: [0.1, 0.42, 0.9, 0.35, 0.6],
    mimeType: UPLOAD_RESPONSE.mimeType,
    sizeBytes: UPLOAD_RESPONSE.sizeBytes,
    ...over,
  };
}

function seed(): Record<string, any[]> {
  return {
    feature_flags: [],
    profiles: [
      { id: ALICE, handle: "alice", name: "Alice", show_name_publicly: true },
      { id: BOB, handle: "bob", name: "Bob", show_name_publicly: true },
    ],
    blocks: [],
    message_threads: [
      {
        id: THREAD,
        thread_type: "direct",
        trip_id: null,
        circle_owner_id: null,
        title: null,
        status: "active",
        is_e2ee: false,
        created_at: "2026-01-01T00:00:00.000Z",
        updated_at: "2026-01-01T00:00:00.000Z",
        last_message_at: "2026-01-01T00:00:00.000Z",
      },
    ],
    message_thread_members: [
      {
        thread_id: THREAD, user_id: ALICE, role: "member",
        joined_at: "2026-01-01T00:00:00.000Z", left_at: null,
        last_read_at: null, muted_at: null, archived_at: null, visible_from_at: null,
      },
      {
        thread_id: THREAD, user_id: BOB, role: "member",
        joined_at: "2026-01-01T00:00:00.000Z", left_at: null,
        last_read_at: null, muted_at: null, archived_at: null, visible_from_at: null,
      },
    ],
    messages: [],
    message_translations: [],
  };
}

// ── one app, three routers, one store ────────────────────────────────────────
//
// The whole point of the file. `_setTestClient` installs the SAME fake as both
// the caller client and the service client, so the row `POST /voice` inserts is
// the row `GET /messages` and `GET /drawer` select from.

let server: Server;
let base = "";
let client: FakeClient;

function install(state: Record<string, any[]> = seed()): FakeClient {
  client = makeFakeClient(state);
  _setTestClient(client as any, true);
  return client;
}

async function req(
  method: "GET" | "POST",
  path: string,
  asUser: string,
  body?: unknown,
): Promise<{ status: number; body: any; raw: string }> {
  const r = await fetch(`${base}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${asUser}`,
      ...(body ? { "content-type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const raw = await r.text();
  let parsed: any = null;
  try { parsed = JSON.parse(raw); } catch { parsed = raw; }
  return { status: r.status, body: parsed, raw };
}

before(async () => {
  const app = express();
  app.use(express.json());
  app.use((rq: any, _res, next) => {
    rq.log = { error() {}, warn() {}, info() {}, debug() {} };
    next();
  });
  // Declaration order copied from routes/index.ts, so a path-shadowing bug
  // would reproduce here rather than being papered over by a tidier mount.
  app.use("/api", telegraphVoiceRouter);
  app.use("/api", telegraphKindsRouter);
  app.use("/api", messagingRouter);
  server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  _setTestClient(null as any, false);
});

beforeEach(() => {
  resetFakeIds();
  install();
});

/** Send one voice note as ALICE and return the 201 body. Fails loudly. */
async function sendVoice(over: Record<string, unknown> = {}) {
  const r = await req("POST", `/threads/${THREAD}/voice`, ALICE, { payload: recorderPayload(over) });
  assert.equal(r.status, 201, `the send leg failed, so nothing after it is being tested: ${r.raw}`);
  return r.body;
}

// ── LEG 0: the upload → send handshake ───────────────────────────────────────

describe("FLOW 1 leg 0 — what the upload route returns is what the send route accepts", () => {
  it("the recorder's payload, built from the upload response VERBATIM, is accepted", async () => {
    // The hop a hand-written fixture cannot test: telegraphVoice.test.ts types
    // its own URL and its own mimeType, so it would stay green if the upload
    // route started returning a signed absolute URL, or `audio/m4a`, or renamed
    // `url` to `storagePath`. Each of those is a change a reasonable person
    // might make to the upload route alone.
    const sent = await sendVoice();
    assert.equal(sent.kind, "VOICE");
    assert.equal(sent.mediaUrl, UPLOAD_RESPONSE.url);
  });

  it("the mimeType the upload route reports is in the allowlist the send route checks", () => {
    // Two independent lists, one on each side of the hop. The sniffer returns
    // `audio/mp4` for BOTH an iOS `M4A ` and an Android `mp42` container, so if
    // this ever goes red the feature has become platform-dependent.
    assert.ok(
      ALLOWED_VOICE_MIME[UPLOAD_RESPONSE.mimeType],
      `the upload route returns ${UPLOAD_RESPONSE.mimeType}, which the send route refuses`,
    );
  });

  it("the ceilings the upload route ADVERTISES are the ones the send route ENFORCES", async () => {
    // The upload response carries `maxDurationSeconds` / `maxWaveformPeaks` so
    // a client need not hard-code them. A client that believed a number the
    // send route does not honour would record right up to a ceiling that
    // refuses it — after the traveller had spoken.
    const atCeiling = await req("POST", `/threads/${THREAD}/voice`, ALICE, {
      payload: recorderPayload({ durationSeconds: UPLOAD_RESPONSE.maxDurationSeconds }),
    });
    assert.equal(atCeiling.status, 201, "the advertised duration ceiling must be sendable");

    install();
    const overCeiling = await req("POST", `/threads/${THREAD}/voice`, ALICE, {
      payload: recorderPayload({ durationSeconds: UPLOAD_RESPONSE.maxDurationSeconds + 1 }),
    });
    assert.equal(overCeiling.status, 400, "one second past the advertised ceiling must be refused");

    install();
    const atPeaks = await req("POST", `/threads/${THREAD}/voice`, ALICE, {
      payload: recorderPayload({ waveform: new Array(UPLOAD_RESPONSE.maxWaveformPeaks).fill(0.5) }),
    });
    assert.equal(atPeaks.status, 201, "the advertised peak cap must be sendable");

    install();
    const overPeaks = await req("POST", `/threads/${THREAD}/voice`, ALICE, {
      payload: recorderPayload({ waveform: new Array(UPLOAD_RESPONSE.maxWaveformPeaks + 1).fill(0.5) }),
    });
    assert.equal(overPeaks.status, 400, "one peak past the advertised cap must be refused");
  });
});

// ── LEG 2: the message appears in the thread read ────────────────────────────

describe("FLOW 1 leg 2 — the voice note comes back out of GET /threads/:id/messages", () => {
  it("the RECIPIENT sees it, with every field the player needs", async () => {
    const sent = await sendVoice();

    const read = await req("GET", `/threads/${THREAD}/messages`, BOB);
    assert.equal(read.status, 200, read.raw);
    const rows: any[] = read.body.messages;
    const m = rows.find((x) => x.id === sent.id);
    assert.ok(m, "the voice note the send route wrote is absent from the thread read");

    // The three things VoiceMessagePlayer is constructed from. A thread read
    // that dropped any one of them renders a play button that never plays, and
    // the send route's own 201 would still look perfect.
    assert.equal(m.mediaUrl, UPLOAD_RESPONSE.url, "no asset reference reaches the renderer");
    assert.equal(m.mediaDurationSeconds, 37, "no duration reaches the renderer");
    assert.equal(m.msgType, "voice", "the renderer dispatches on msgType and would not recognise this row");

    // §6.4 / §11.3 — the waveform is a DERIVATIVE and travels in the envelope,
    // not in a column. It must survive the round trip through `messages.body`.
    const env = JSON.parse(m.body);
    assert.equal(env.kind, "VOICE");
    assert.equal(env.envelopeVersion, "1");
    assert.deepEqual(env.payload.waveform, [0.1, 0.42, 0.9, 0.35, 0.6]);
  });

  it("`mediaType` reaches the client as 'audio' — the value 2989 exists to admit", async () => {
    const sent = await sendVoice();
    const read = await req("GET", `/threads/${THREAD}/messages`, BOB);
    const m = read.body.messages.find((x: any) => x.id === sent.id);
    assert.equal(m.mediaType, "audio");
  });

  it("the SENDER sees their own voice note too", async () => {
    // Not a tautology: the thread read runs different branches for the caller's
    // own messages (translation is skipped, the safety annotation is withheld,
    // `senderConnected` short-circuits). A row that only survived one branch
    // would be a voice note the sender could not see in their own thread.
    const sent = await sendVoice();
    const read = await req("GET", `/threads/${THREAD}/messages`, ALICE);
    const m = read.body.messages.find((x: any) => x.id === sent.id);
    assert.ok(m, "the sender cannot see their own voice note");
    assert.equal(m.mediaUrl, UPLOAD_RESPONSE.url);
  });

  it("a NON-MEMBER cannot reach it, and the asset reference is absent from the whole body", async () => {
    await sendVoice();
    const read = await req("GET", `/threads/${THREAD}/messages`, CAROL);
    assert.equal(read.status, 403);
    // Scanned rather than asserted field by field: a leak through some other
    // key is exactly what a field-by-field check cannot see.
    assert.ok(!read.raw.includes("/voice/"), `the asset path leaked to a non-member: ${read.raw}`);
  });
});

// ── LEG 3: §6.4's content drawer ─────────────────────────────────────────────

describe("FLOW 1 leg 3 — the voice note is indexed into §6.4's VOICE tab", () => {
  it("appears under VOICE, is COUNTED under VOICE, and appears under no other tab", async () => {
    const sent = await sendVoice();

    const all = await req("GET", `/threads/${THREAD}/drawer`, BOB);
    assert.equal(all.status, 200, all.raw);
    assert.equal(all.body.counts.VOICE, 1, "the drawer did not count the voice note under VOICE");
    for (const tab of DRAWER_TABS) {
      if (tab === "VOICE") continue;
      assert.equal(
        all.body.counts[tab], 0,
        `a voice note was also counted under ${tab} — §6.4's tabs are a partition, ` +
        `and a row in two tabs is a row a traveller meets twice`,
      );
    }

    const voiceTab = await req("GET", `/threads/${THREAD}/drawer?tab=VOICE`, BOB);
    assert.equal(voiceTab.status, 200);
    assert.deepEqual(
      voiceTab.body.items.map((i: any) => i.id), [sent.id],
      "the VOICE tab does not contain the voice note",
    );
    assert.equal(voiceTab.body.items[0].tab, "VOICE");

    // §6.4 — "a structured index over exchanged content, not a second storage
    // copy". The id in the drawer is the id in the thread; the drawer minted
    // nothing.
    assert.equal(voiceTab.body.indexOnly, true);
  });

  it("the MEDIA tab does NOT claim it — a voice note is not a photo", async () => {
    // The trap: `drawerTabFor` tests `media_url && media_type` FIRST, and a
    // voice note has both. It escapes the MEDIA branch only because that branch
    // names `image` and `video` explicitly. Widening it to "has media_url" —
    // which reads like a simplification — puts every voice note in the photo
    // grid and empties the VOICE tab.
    await sendVoice();
    const mediaTab = await req("GET", `/threads/${THREAD}/drawer?tab=MEDIA`, BOB);
    assert.equal(mediaTab.status, 200);
    assert.deepEqual(mediaTab.body.items, []);
  });

  it("is NOT returned by object-aware search — there is no transcript to match", async () => {
    // §6.4's search matches on text. A voice note has none. Indexing its URL
    // would make a search for "m4a", or for the sender's own user id, return
    // conversations — and would look like a working search until someone read
    // what it had matched on.
    await sendVoice();
    const hits = await req("GET", `/threads/${THREAD}/search?q=voice`, BOB);
    assert.equal(hits.status, 200, hits.raw);
    assert.deepEqual(hits.body.results, [], "a voice note was matched by a text search");

    const byPath = await req("GET", `/threads/${THREAD}/search?q=m4a`, BOB);
    assert.deepEqual(byPath.body.results, [], "the asset path is indexed as searchable text");
  });

  it("a non-member is refused the drawer as a REFUSAL, not as an empty index", async () => {
    // §6.4's stated trap: "a refusal and an empty drawer must not wear the same
    // shape". An empty 200 here would tell an outsider this conversation has
    // nothing in it, which is itself a disclosure.
    await sendVoice();
    const drawer = await req("GET", `/threads/${THREAD}/drawer?tab=VOICE`, CAROL);
    assert.equal(drawer.status, 403);
    assert.equal(drawer.body?.items, undefined, "a refusal answered with an index");
  });
});

// ── LEG 4: what the client parser is handed ──────────────────────────────────

describe("FLOW 1 leg 4 — the client's parser, run against the real thread-read payload", () => {
  /**
   * `travel-buddy-standalone/src/features/telegraph/kinds/kindsApi.ts#parseKindEnvelope`,
   * transcribed. NOT imported: `travel-buddy-standalone` is not in
   * `pnpm-workspace.yaml`, so this package cannot import from it and vice
   * versa. Transcribing is the only way to assert, from the server's side, that
   * the bytes the server sends are bytes that client accepts — and the
   * transcription is short enough to check by eye against the original.
   */
  function clientParseKindEnvelope(msgType: string | null, body: string | null) {
    const CLIENT_ENVELOPE_KINDS = [
      "MEDIA_ALBUM", "GIF", "LOCATION", "ACTION", "ANNOUNCEMENT", "SAFETY", "MEMORY_NOTE", "VOICE",
    ];
    if (typeof msgType !== "string" || typeof body !== "string" || body.length === 0) return null;
    const kind = msgType.toUpperCase();
    if (!CLIENT_ENVELOPE_KINDS.includes(kind)) return null;
    let parsed: any;
    try { parsed = JSON.parse(body); } catch { return null; }
    if (!parsed || parsed.kind !== kind || parsed.envelopeVersion !== "1") return null;
    return { kind, envelopeVersion: "1" as const, payload: parsed.payload };
  }

  it("parses the stored row into a VOICE bubble with a playable payload", async () => {
    const sent = await sendVoice();
    const read = await req("GET", `/threads/${THREAD}/messages`, BOB);
    const m = read.body.messages.find((x: any) => x.id === sent.id);

    const parsed = clientParseKindEnvelope(m.msgType, m.body);
    assert.ok(parsed, "the client parser returns null for this row — it would render a blank bubble");
    assert.equal(parsed!.kind, "VOICE");
    assert.equal(parsed!.payload.url, UPLOAD_RESPONSE.url);
    assert.equal(parsed!.payload.durationSeconds, 37);
    assert.equal(parsed!.payload.waveform.length, 5);
  });

  it("the `msgType` the server writes is the lower-case spelling the client upper-cases back", async () => {
    // The whole envelope contract rests on `msgTypeOf`/`kindOfMsgType` being
    // exact inverses ACROSS the two trees. A server that wrote `VOICE` or
    // `voice_message` would still round-trip inside the server's own tests.
    const sent = await sendVoice();
    assert.equal(sent.msgType, "voice");
    assert.equal(sent.msgType.toUpperCase(), "VOICE");
  });

  it("an empty waveform still parses and still plays — §11.3, a derivative may not gate the original", async () => {
    const sent = await sendVoice({ waveform: [] });
    const read = await req("GET", `/threads/${THREAD}/messages`, BOB);
    const m = read.body.messages.find((x: any) => x.id === sent.id);
    const parsed = clientParseKindEnvelope(m.msgType, m.body);
    assert.ok(parsed, "a voice note whose meter produced nothing became unrenderable");
    assert.deepEqual(parsed!.payload.waveform, []);
    assert.equal(m.mediaUrl, UPLOAD_RESPONSE.url, "the original must remain reachable");
  });
});

// ── the whole flow, in one pass ──────────────────────────────────────────────

describe("FLOW 1 — record → upload → send → read → drawer, as one traveller's action", () => {
  it("one voice note is one row, reachable from all three surfaces, and nothing else moved", async () => {
    const sent = await sendVoice();

    // Exactly one `messages` row, and it is the one.
    const written = client._store.messages;
    assert.equal(written.length, 1, "the send path wrote more or fewer than one row");
    assert.equal(written[0].media_type, "audio");
    assert.equal(written[0].msg_type, "voice");

    // The thread's `last_message_at` moved, so the inbox will show it. A voice
    // note that does not bump the thread sits in a conversation nobody reopens.
    const thread = client._store.message_threads[0];
    assert.notEqual(
      thread.last_message_at, "2026-01-01T00:00:00.000Z",
      "the thread was not bumped, so this voice note never reaches the inbox ordering",
    );

    // All three surfaces agree on the same id.
    const read = await req("GET", `/threads/${THREAD}/messages`, BOB);
    const drawer = await req("GET", `/threads/${THREAD}/drawer?tab=VOICE`, BOB);
    assert.equal(read.body.messages[0].id, sent.id);
    assert.equal(drawer.body.items[0].id, sent.id);
    assert.equal(written[0].id, sent.id);
  });

  it("a voice REPLY carries reply_to_id IN THE INSERT — a seam with the ordinary send path", async () => {
    // FINDING, pinned rather than argued. `messages.reply_to_id` is migration
    // 0057's column, and the two lanes that write this table disagree about
    // whether it exists:
    //
    //   routes/messaging.ts  writes it as a SEPARATE fire-and-forget UPDATE
    //                        after the insert ("requires migration
    //                        0057_reply_to_messages.sql"), and its READ path
    //                        wraps the column in a try/catch because "reply
    //                        threading genuinely predates migration 0057 on
    //                        some deployments and an absent column is a
    //                        legitimate state".
    //   routes/telegraphVoice.ts  puts it in the INSERT itself.
    //
    // On a deployment where 0057 is absent, the ordinary path loses the reply
    // LINK and still delivers the message; the voice path loses the whole
    // VOICE NOTE, with a 42703 the route reports as a generic db_error. This
    // case does not assert which behaviour is right — it pins the divergence
    // so it cannot be changed by accident in either direction while nobody is
    // comparing the two writers.
    const replyTo = "eeeeeeee-0000-4000-8000-00000000000e";
    const r = await req("POST", `/threads/${THREAD}/voice`, ALICE, {
      payload: recorderPayload(),
      replyToId: replyTo,
    });
    assert.equal(r.status, 201, r.raw);
    assert.equal(r.body.replyToId, replyTo);

    const insert = client._observed.inserts.find((i) => i.table === "messages");
    assert.ok(insert, "no messages insert was observed");
    assert.ok(
      "reply_to_id" in insert!.rows[0],
      "the voice insert no longer names reply_to_id — if this was a deliberate move to " +
      "match routes/messaging.ts's post-insert UPDATE, update this case and say so",
    );
    assert.equal(insert!.rows[0].reply_to_id, replyTo);
  });

  it("an UNKNOWN-COLUMN failure is NOT reported as the 2989 migration refusal", async () => {
    // The companion to the case above. `isAudioMediaTypeRejection` keys on
    // SQLSTATE 23514 and on the constraint name; 42703 is "column does not
    // exist", which is what an absent `reply_to_id` produces. Reporting that
    // as "apply migration 2989" would send an operator to the wrong migration
    // entirely, and the voice note is lost either way.
    install(seed());
    // `makeFakeClient` injects a RESOLVED PostgREST error, which is how
    // supabase-js reports this — it does not throw.
    const { makeFakeClient } = await import("./telegraphCertificationHarness.js");
    const c = makeFakeClient(seed(), {
      errors: {
        messages: {
          code: "42703",
          message: 'column "reply_to_id" of relation "messages" does not exist',
        },
      },
    });
    _setTestClient(c as any, true);

    const r = await req("POST", `/threads/${THREAD}/voice`, ALICE, { payload: recorderPayload() });
    assert.notEqual(r.status, 201);
    assert.equal(r.body.error, "db_error", `expected db_error, got ${r.raw}`);
    assert.ok(
      !String(r.body.message ?? "").includes("2989"),
      `a missing-column failure was reported as the audio migration: ${r.raw}`,
    );
  });

  it("a REFUSED send leaves no trace on any of the three surfaces", async () => {
    // The negative control the flow needs: a suite that only ever sends
    // successfully cannot tell a working write from a write that always
    // succeeds. An E2EE thread is refused by name.
    const st = seed();
    st.message_threads[0].is_e2ee = true;
    install(st);

    const refused = await req("POST", `/threads/${THREAD}/voice`, ALICE, { payload: recorderPayload() });
    assert.equal(refused.body.error, "e2ee_thread");
    assert.equal(client._store.messages.length, 0);

    const read = await req("GET", `/threads/${THREAD}/messages`, BOB);
    assert.deepEqual(read.body.messages, []);
    const drawer = await req("GET", `/threads/${THREAD}/drawer`, BOB);
    assert.equal(drawer.body.counts.VOICE, 0);
  });
});

/**
 * MUTATIONS RUN, WITH THE COUNTS THEY PRODUCED. Baseline 18/18. Every mutant
 * was applied to the tree, the suite re-run, and the file restored from a
 * byte-for-byte copy afterwards; `git status` was clean of source changes at
 * the end.
 *
 *   • `routes/messaging.ts` — the `mediaDurationSeconds` line deleted from the
 *     thread read's message projection, which is what tidying up a "voice-only
 *     column" looks like → 15/1 (measured at the 16-case baseline), on the leg-2 player-fields case. THIS IS THE
 *     DEFECT CLASS THE FILE EXISTS FOR: `telegraphVoice.test.ts` stays 42/42
 *     green through it, because the 201 body carries that field straight from
 *     the INSERT and never from a read.
 *   • `services/telegraph/messageKinds.ts` — `drawerTabFor`'s MEDIA branch
 *     widened from `media_url && (media_type === "image" || "video")` to a bare
 *     `row.media_url` → 13/3 (measured at the 16-case baseline): the VOICE-tab case, the tab-partition case and
 *     the MEDIA-tab case. The voice note lands in the photo grid and the VOICE
 *     tab empties — and that widening reads like a simplification of the line.
 *   • `services/telegraph/voice.ts` — `msg_type` written as `"VOICE"` instead
 *     of `"voice"` → 13/3 (measured at the 16-case baseline). Everything downstream of the write: `drawerTabFor`
 *     and the client parser both key off the lower-case spelling, and the row
 *     still round-trips perfectly inside the send route's own response.
 *   • `services/telegraph/messageKinds.ts` — `searchableTextOf` returning the
 *     raw body for VOICE (adding `|| kind === "VOICE"` to the TEXT/SYSTEM arm)
 *     → 15/1 (measured at the 16-case baseline), on the `m4a` search case: the storage path becomes searchable
 *     text and a search for "m4a" starts returning conversations.
 *   • `routes/telegraphVoice.ts` — the `message_threads` bump removed → 17/1,
 *     on the whole-flow case. A voice note that does not bump the thread never
 *     reaches the inbox ordering.
 *   • `services/telegraph/voice.ts` — `reply_to_id` dropped from the insert
 *     (the shape `routes/messaging.ts` uses) → 17/1, on the seam case. That is
 *     the point of pinning a divergence: it cannot move in EITHER direction
 *     without somebody being told.
 *   • `services/telegraph/voice.ts` — `isAudioMediaTypeRejection` widened to
 *     admit SQLSTATE 42703 → 17/1. A missing column starts reporting "apply
 *     migration 2989", which sends an operator to the wrong migration while the
 *     voice note is lost either way.
 *   • `lib/telegraphThreadWrite.ts` — the `is_e2ee` refusal bypassed → 15/1 (measured at the 16-case baseline), on
 *     the refused-send control. That control is what stops this suite proving a
 *     write path that always succeeds.
 *
 * TWO MUTANTS THAT DID NOT REDDEN, recorded because a surviving mutation is the
 * only one that tells you something you did not already know:
 *
 *   • `parseKindEnvelope` guarded with `isSendableEnvelopeKind` instead of
 *     `isEnvelopeKind` — the pre-integration spelling its own header warns
 *     about → 16/16 (the then-complete baseline). NOT A GAP THAT MATTERS HERE, and the reason is worth
 *     stating: a VOICE row that fails to parse falls through `searchableTextOf`'s
 *     LEGACY arm, which JSON-parses the body and reads only `title`/`caption`/
 *     `blurb`/`snippet`/`city`/`name` — none of which a voice envelope has — so
 *     it still returns null. `drawerTabFor` never calls the parser at all. The
 *     regression the header describes is a BLANK BUBBLE on the client, and the
 *     client has its own parser (leg 4), which this mutation does not touch.
 *     The server-side consequence is genuinely nil, and the test that would
 *     catch the client-side one lives in the client tree.
 *   • `routes/telegraphVoice.ts` — the `appStorageUrlInfo` foreign-URL check
 *     bypassed → 16/16 (the then-complete baseline). Already covered, with three attack URLs, by
 *     `telegraphVoice.test.ts`; this file drives only well-formed payloads
 *     because its subject is the hand-off, not the gate. Named rather than left
 *     for a reader to infer from a green run.
 */
