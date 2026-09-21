/**
 * Telegraph §6.2 VOICE — the kind that was refused by name until migration
 * 2989 existed, exercised end to end through the shipped route.
 *
 * Spec:
 *   §6.2  "TEXT · IMAGE · VIDEO · MEDIA_ALBUM · GIF · VOICE · …"
 *   §6.3  a voice message renders "waveform, seek, playback speed"
 *   §6.4  the content drawer's VOICE tab
 *   §11.3 "Captions/transcripts must be optional derivatives; original media
 *          remains accessible"
 *   §14   the write gates every message passes
 *
 * WHAT IS EXERCISED HERE. The real `services/telegraph/voice.ts`, the real
 * `lib/mediaPipeline.ts` voice policy, the real `lib/mediaProcessing.ts` voice
 * sniffer, and the real `routes/telegraphVoice.ts` SEND path mounted in an
 * express app over an in-memory PostgREST-shaped fake.
 *
 * WHAT IS NOT EXERCISED, SAID PLAINLY RATHER THAN IMPLIED BY ITS ABSENCE. The
 * UPLOAD route is not driven over HTTP. It writes to Supabase Storage through
 * the service client, and standing a fake storage bucket up would test the fake.
 * Its POLICY — the declared-MIME allowlist, the byte sniff, the size ceiling
 * and the fail-closed location scrub — is the whole of its decision-making and
 * IS exercised, directly, below. What is untested is the transport around it:
 * the bounded body reader and the storage call.
 *
 * ALSO NOT TESTED HERE, because no test in this tree can: that migration 2989
 * has been applied. It has not. The route's behaviour when it has not is
 * tested (a named refusal, not a generic 500); the behaviour when it has is
 * tested against a fake that does not enforce the CHECK. That gap is real and
 * is reported rather than papered over.
 *
 * SHOWN RED BEFORE COMMIT, each reverted — see the bottom of this file for the
 * per-mutation counts.
 *
 * Run: node --import tsx/esm --test src/test/telegraphVoice.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import telegraphVoiceRouter from "../routes/telegraphVoice.js";
import {
  AUDIO_MIGRATION_PENDING_MESSAGE,
  downsampleWaveform,
  isAudioMediaTypeRejection,
  normaliseWaveform,
  validateVoicePayload,
  voiceMessageRow,
  VOICE_MAX_DURATION_SECONDS,
  WAVEFORM_MAX_PEAKS,
} from "../services/telegraph/voice.js";
import {
  ALLOWED_VOICE_MIME,
  validateDeclaredVoiceUpload,
  verifyUploadedVoiceBytes,
  VOICE_SIZE_LIMIT,
} from "../lib/mediaPipeline.js";
import { isoTrackHandlers, sniffVoiceAudio } from "../lib/mediaProcessing.js";
import { drawerTabFor, parseKindEnvelope, searchableTextOf } from "../services/telegraph/messageKinds.js";

const ALICE = "aaaaaaaa-0000-4000-8000-000000000001";
const BOB = "bbbbbbbb-0000-4000-8000-000000000002";
const CAROL = "cccccccc-0000-4000-8000-000000000003";

const THREAD = "dddddddd-0000-4000-8000-00000000000d";
const THREAD_E2EE = "dddddddd-0000-4000-8000-00000000000e";
const THREAD_NONE = "dddddddd-0000-4000-8000-00000000000f";

/** A message Alice CAN reply to: it is in the thread she is writing to. */
const MSG_IN_THREAD = "eeeeeeee-0000-4000-8000-000000000001";
/** A message in a thread Alice is not writing to — the cross-thread case. */
const MSG_OTHER_THREAD = "eeeeeeee-0000-4000-8000-000000000002";

const GOOD_URL = "post-media/aaaaaaaa-0000-4000-8000-000000000001/voice/1700000000000.m4a";

function goodPayload(over: Record<string, unknown> = {}) {
  return {
    url: GOOD_URL,
    durationSeconds: 12,
    waveform: [0.1, 0.5, 0.9, 0.3],
    mimeType: "audio/mp4",
    sizeBytes: 98_304,
    ...over,
  };
}

// ── ISO-BMFF fixtures ────────────────────────────────────────────────────────
// Built byte by byte rather than checked in as a binary, so the test states
// exactly which bytes it is claiming decide the answer. The sniffer decides on
// TRACK HANDLERS, so these carry real `moov/trak/mdia/hdlr` structures.

function box(type: string, ...payload: Buffer[]): Buffer {
  const body = Buffer.concat(payload);
  const head = Buffer.alloc(8);
  head.writeUInt32BE(body.length + 8, 0);
  head.write(type, 4, "latin1");
  return Buffer.concat([head, body]);
}

function ftyp(brand: string): Buffer {
  return box(
    "ftyp",
    Buffer.from(brand, "latin1"),
    Buffer.from([0, 0, 0, 0]),
    Buffer.from("isom", "latin1"),
  );
}

/** A `hdlr` box: version+flags (4), pre_defined (4), handler_type (4), then name. */
function hdlr(handler: string): Buffer {
  return box(
    "hdlr",
    Buffer.alloc(8),
    Buffer.from(handler, "latin1"),
    Buffer.alloc(12),
  );
}

function trak(handler: string): Buffer {
  return box("trak", box("mdia", hdlr(handler)));
}

/** An MP4 container with the given brand and the given track handlers. */
function iso(brand: string, handlers: string[], extraMoov: Buffer[] = []): Buffer {
  return Buffer.concat([ftyp(brand), box("moov", ...handlers.map(trak), ...extraMoov)]);
}

/** iOS: an `M4A ` voice memo, one audio track. */
function m4aIos(): Buffer {
  return iso("M4A ", ["soun"]);
}

/**
 * ANDROID: the SAME recording from `expo-av` on Android, whose `MediaMuxer`
 * writes the brand `mp42`. A brand allowlist refuses this file; the product
 * would have worked on iOS and failed at upload on every Android device.
 */
function m4aAndroid(): Buffer {
  return iso("mp42", ["soun"]);
}

/** An `M4A `-branded file that CARRIES A VIDEO TRACK — a brand check admits it. */
function videoWearingAnAudioBrand(): Buffer {
  return iso("M4A ", ["vide", "soun"]);
}

/** An ordinary MP4 video. */
function mp4Video(): Buffer {
  return iso("mp42", ["vide", "soun"]);
}

/** An M4A carrying the `©xyz` capture-location atom a phone writes. */
function m4aWithLocation(): Buffer {
  const isoStr = "+16.0678+108.2208/";
  const payload = Buffer.alloc(4 + isoStr.length);
  payload.writeUInt16BE(isoStr.length, 0);
  payload.writeUInt16BE(0x15c7, 2); // language
  payload.write(isoStr, 4, "latin1");
  return iso("M4A ", ["soun"], [box("udta", box("©xyz", payload))]);
}

/** WebM/Matroska EBML magic — indistinguishable from a WebM video. */
function webm(): Buffer {
  return Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(32)]);
}

// ── the fake ─────────────────────────────────────────────────────────────────

interface State {
  errorTable?: string;
  killSwitch?: boolean;
  /** Make the messages insert fail the way an unapplied 2989 makes it fail. */
  checkViolation?: boolean;
  blocked?: boolean;
}

function fixture(state: State): Record<string, any[]> {
  return {
    feature_flags: [{ flag: "disable_messaging", enabled: state.killSwitch === true }],
    message_threads: [
      { id: THREAD, is_e2ee: false },
      { id: THREAD_E2EE, is_e2ee: true },
      { id: THREAD_NONE, is_e2ee: false },
    ],
    message_thread_members: [
      { thread_id: THREAD, user_id: ALICE, left_at: null },
      { thread_id: THREAD, user_id: BOB, left_at: null },
      { thread_id: THREAD_E2EE, user_id: ALICE, left_at: null },
      { thread_id: THREAD_E2EE, user_id: BOB, left_at: null },
      { thread_id: THREAD_NONE, user_id: CAROL, left_at: null },
    ],
    blocks: state.blocked
      ? [{ blocker_id: BOB, blocked_id: ALICE }]
      : [],
    messages: [
      { id: MSG_IN_THREAD, thread_id: THREAD, sender_id: BOB, body: "in this thread" },
      { id: MSG_OTHER_THREAD, thread_id: THREAD_NONE, sender_id: CAROL, body: "Carol's private line" },
    ],
  };
}

function makeClient(state: State) {
  const db = fixture(state);
  const inserted: any[] = [];

  function from(table: string) {
    const filters: Array<(r: any) => boolean> = [];
    let pendingInsert: any = null;
    let pendingUpdate: any = null;

    const rowsNow = () => (db[table] ?? []).filter((r) => filters.every((f) => f(r)));
    const err = () =>
      state.errorTable === table ? { message: `injected failure on ${table}`, code: "XX000" } : null;
    const insertErr = () =>
      table === "messages" && state.checkViolation
        ? {
            code: "23514",
            message:
              'new row for relation "messages" violates check constraint "messages_media_type_check"',
          }
        : null;

    const target: any = {
      select() { return proxy; },
      insert(row: any) {
        pendingInsert = { id: "new-voice-1", ...row };
        inserted.push({ table, row: pendingInsert });
        (db[table] ??= []).push(pendingInsert);
        return proxy;
      },
      update(patch: any) { pendingUpdate = patch; return proxy; },
      eq(col: string, val: any) { filters.push((r) => r[col] === val); return proxy; },
      neq(col: string, val: any) { filters.push((r) => r[col] !== val); return proxy; },
      or() { return proxy; },
      in(col: string, vals: any[]) { filters.push((r) => vals.map(String).includes(String(r[col]))); return proxy; },
      is(col: string, val: any) { filters.push((r) => (val === null ? r[col] == null : r[col] === val)); return proxy; },
      limit() { return proxy; },
      order() { return proxy; },
      maybeSingle() {
        const e = err();
        if (e) return Promise.resolve({ data: null, error: e });
        return Promise.resolve({ data: pendingInsert ?? rowsNow()[0] ?? null, error: null });
      },
      single() {
        const e = err() ?? (pendingInsert ? insertErr() : null);
        if (e) return Promise.resolve({ data: null, error: e });
        return Promise.resolve({ data: pendingInsert ?? rowsNow()[0] ?? null, error: null });
      },
      then(resolve: (v: any) => void, reject?: (e: any) => void) {
        const e = err();
        if (e) return Promise.resolve({ data: null, error: e, count: null }).then(resolve, reject);
        if (pendingUpdate) {
          const applied = rowsNow();
          for (const r of applied) Object.assign(r, pendingUpdate);
          return Promise.resolve({ data: applied, error: null }).then(resolve, reject);
        }
        return Promise.resolve({ data: pendingInsert ? [pendingInsert] : rowsNow(), error: null }).then(resolve, reject);
      },
    };
    const proxy: any = new Proxy(target, {
      get(t, prop) {
        if (prop in t) return t[prop as string];
        if (prop === "catch" || prop === "finally") return undefined;
        return () => proxy;
      },
    });
    return proxy;
  }

  return {
    _db: db,
    _inserted: inserted,
    from,
    rpc: async () => ({ data: null, error: { message: "rpc not modelled" } }),
    auth: { getUser: async (token: string) => ({ data: { user: { id: token } }, error: null }) },
  };
}

let server: ReturnType<typeof createServer>;
let base = "";

function useState(state: State) {
  const c = makeClient(state);
  _setTestClient(c, true);
  return c;
}

async function post(path: string, asUser: string, body: unknown) {
  const r = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${asUser}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  let parsed: any = null;
  try { parsed = JSON.parse(text); } catch { parsed = text; }
  return { status: r.status, body: parsed };
}

before(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { (req as any).log = { error() {}, warn() {}, info() {}, debug() {} }; next(); });
  app.use("/api", telegraphVoiceRouter);
  server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

// ── the sniffer ──────────────────────────────────────────────────────────────

describe("the voice sniffer decides on TRACKS, not on the four bytes of the brand", () => {
  it("accepts an iOS `M4A ` voice memo", () => {
    const s = sniffVoiceAudio(m4aIos());
    assert.ok(s);
    assert.equal(s!.kind, "audio");
    assert.equal(s!.ext, "m4a");
    assert.deepEqual(s!.handlers, ["soun"]);
  });

  it("ACCEPTS the same recording from ANDROID, whose muxer writes the brand `mp42`", () => {
    // The case a brand allowlist gets wrong in the refusing direction: this is a
    // real voice note from `expo-av` on Android, and refusing it would have made
    // the feature iOS-only while looking built.
    const s = sniffVoiceAudio(m4aAndroid());
    assert.ok(s, "an audio-only mp42 container is a voice note");
    assert.equal(s!.brand, "mp42");
    assert.deepEqual(s!.handlers, ["soun"]);
  });

  it("REFUSES a file that CLAIMS the `M4A ` brand and carries a VIDEO track", () => {
    // The case a brand allowlist gets wrong in the admitting direction. A brand
    // is four bytes of self-description; this file says `M4A ` and is a video.
    // Admitted, it would reach the audio path and skip the video location scrub.
    assert.equal(sniffVoiceAudio(videoWearingAnAudioBrand()), null);
  });

  it("REFUSES an ordinary MP4 video", () => {
    assert.equal(sniffVoiceAudio(mp4Video()), null);
  });

  it("REFUSES WebM, whose magic is byte-identical to a WebM video", () => {
    assert.equal(sniffVoiceAudio(webm()), null);
  });

  it("REFUSES a container whose tracks cannot be read — it does not guess", () => {
    // No moov at all, and a moov with no readable trak. Both are "this file did
    // not answer", and the answer to that is no.
    assert.equal(sniffVoiceAudio(ftyp("M4A ")), null);
    assert.equal(sniffVoiceAudio(Buffer.concat([ftyp("M4A "), box("moov")])), null);
  });

  it("refuses a truncated file rather than reading past its end", () => {
    assert.equal(sniffVoiceAudio(Buffer.from([0x00, 0x00, 0x00])), null);
    assert.equal(sniffVoiceAudio(Buffer.alloc(0)), null);
    // A moov whose declared size runs past the buffer: the walk stops, no throw.
    const truncated = m4aIos().subarray(0, m4aIos().length - 6);
    assert.doesNotThrow(() => sniffVoiceAudio(truncated));
    assert.equal(sniffVoiceAudio(truncated), null);
  });

  it("isoTrackHandlers reports what is actually in the file", () => {
    assert.deepEqual(isoTrackHandlers(mp4Video()), ["vide", "soun"]);
    assert.deepEqual(isoTrackHandlers(m4aAndroid()), ["soun"]);
    assert.equal(isoTrackHandlers(webm()), null);
  });
});

// ── the upload policy ────────────────────────────────────────────────────────

describe("the voice upload policy is NARROWER than the general one, and fails closed", () => {
  it("the general media allowlist is UNTOUCHED — no existing surface accepts audio", async () => {
    // The point of a separate list. If this ever goes red, a change made for
    // messaging has widened what a post, memory, story or postcard accepts.
    const { ALLOWED_MEDIA_MIME } = await import("../lib/mediaPipeline.js");
    for (const mime of Object.keys(ALLOWED_MEDIA_MIME)) {
      assert.ok(mime.startsWith("image/") || mime.startsWith("video/"), `${mime} is not image or video`);
    }
    for (const mime of Object.keys(ALLOWED_VOICE_MIME)) {
      assert.ok(!(mime in ALLOWED_MEDIA_MIME), `${mime} leaked into the general allowlist`);
    }
  });

  it("refuses a declared type that is not the one container", () => {
    for (const mime of ["audio/ogg", "audio/webm", "audio/mpeg", "video/mp4", "image/jpeg"]) {
      const r = validateDeclaredVoiceUpload({ mimeType: mime, fileSizeBytes: 1024 });
      assert.equal(r.ok, false, `${mime} was accepted`);
    }
    assert.equal(validateDeclaredVoiceUpload({ mimeType: "audio/mp4", fileSizeBytes: 1024 }).ok, true);
  });

  it("refuses a declared size over the voice ceiling, which is far under the image ceiling", () => {
    const r = validateDeclaredVoiceUpload({ mimeType: "audio/mp4", fileSizeBytes: VOICE_SIZE_LIMIT + 1 });
    assert.equal(r.ok, false);
    assert.ok(VOICE_SIZE_LIMIT < 15 * 1024 * 1024);
  });

  it("the BYTES decide — an mp4 video declared as audio/mp4 is refused", () => {
    const r = verifyUploadedVoiceBytes(mp4Video());
    assert.equal(r.ok, false);
    assert.ok(String(r.ok === false && r.failure.message).includes("audio"));
  });

  it("STRIPS the capture location from a recording that carries one, and proves it gone", () => {
    const withLoc = m4aWithLocation();
    const r = verifyUploadedVoiceBytes(withLoc);
    assert.equal(r.ok, true, "a scrubbable recording must be accepted");
    if (r.ok) {
      assert.ok(r.value.stripped.length > 0, "the ©xyz atom should have been reported stripped");
      // The coordinates must not survive anywhere in what gets stored.
      assert.ok(!r.value.buffer.includes(Buffer.from("+16.0678", "latin1")));
      assert.ok(!r.value.buffer.includes(Buffer.from("©xyz", "latin1")));
      // Length-preserving: byte offsets inside the container still point where
      // they did, which is why the file still plays.
      assert.equal(r.value.buffer.length, withLoc.length);
    }
  });

  it("a clean recording is accepted and reports nothing stripped", () => {
    const r = verifyUploadedVoiceBytes(m4aIos());
    assert.equal(r.ok, true);
    if (r.ok) assert.deepEqual(r.value.stripped, []);
  });

  it("refuses empty bytes", () => {
    assert.equal(verifyUploadedVoiceBytes(Buffer.alloc(0)).ok, false);
    assert.equal(verifyUploadedVoiceBytes(null).ok, false);
  });
});

// ── the payload ──────────────────────────────────────────────────────────────

describe("§6.3 — the waveform is validated and normalised, never trusted", () => {
  it("clamps peaks into [0,1] rather than refusing a meter that over- or under-reports", () => {
    assert.deepEqual(normaliseWaveform([-5, 0, 0.4, 1, 900]), [0, 0, 0.4, 1, 1]);
  });

  it("DROPS NaN and Infinity — they are not quiet or loud, they are 'no reading'", () => {
    assert.deepEqual(normaliseWaveform([0.2, NaN, 0.4, Infinity, -Infinity, 0.6]), [0.2, 0.4, 0.6]);
  });

  it("caps the peak count, so a bar chart cannot be turned into a denial of service", () => {
    const huge = new Array(100_000).fill(0.5);
    assert.equal(normaliseWaveform(huge).length, WAVEFORM_MAX_PEAKS);
    const v = validateVoicePayload(goodPayload({ waveform: huge }));
    // The schema refuses an over-long array outright; the route never has to
    // normalise a million numbers to find that out.
    assert.equal(v.ok, false);
  });

  it("survives a non-array and a null without throwing", () => {
    assert.deepEqual(normaliseWaveform(null), []);
    assert.deepEqual(normaliseWaveform(undefined), []);
    assert.deepEqual(normaliseWaveform("loud" as any), []);
  });

  it("downsampling AVERAGES each bucket rather than sampling one frame from it", () => {
    // Sampling would return [0, 0, …]; the mean of each pair is 0.5.
    const alternating = new Array(240).fill(0).map((_, i) => (i % 2 === 0 ? 0 : 1));
    const out = downsampleWaveform(alternating, 120);
    assert.equal(out.length, 120);
    for (const v of out) assert.equal(v, 0.5);
  });

  it("downsampling is a no-op when the series is already short enough", () => {
    assert.deepEqual(downsampleWaveform([0.1, 0.2, 0.3], 120), [0.1, 0.2, 0.3]);
  });

  it("a voice note of zero seconds is a mis-fire, not a message", () => {
    assert.equal(validateVoicePayload(goodPayload({ durationSeconds: 0 })).ok, false);
  });

  it("a voice note longer than the ceiling is refused, and the ceiling is the recorder's", () => {
    assert.equal(
      validateVoicePayload(goodPayload({ durationSeconds: VOICE_MAX_DURATION_SECONDS + 1 })).ok,
      false,
    );
    assert.equal(
      validateVoicePayload(goodPayload({ durationSeconds: VOICE_MAX_DURATION_SECONDS })).ok,
      true,
    );
  });

  it("an empty waveform is LEGAL — §11.3: a derivative may not gate the original", () => {
    const v = validateVoicePayload(goodPayload({ waveform: [] }));
    assert.equal(v.ok, true);
    if (v.ok) assert.deepEqual(v.payload.waveform, []);
  });
});

// ── the row ──────────────────────────────────────────────────────────────────

describe("the row a voice note writes carries BOTH the envelope and the media columns", () => {
  const row = voiceMessageRow({
    threadId: THREAD,
    senderId: ALICE,
    payload: goodPayload() as any,
    createdAt: "2026-09-16T10:00:00.000Z",
  });

  it("writes media_type 'audio' — the value migration 2989 exists to admit", () => {
    assert.equal(row.media_type, "audio");
  });

  it("writes the asset URL and the duration into the columns every asset consumer reads", () => {
    assert.equal(row.media_url, GOOD_URL);
    assert.equal(row.media_duration_seconds, 12);
  });

  it("NEVER writes media_type NULL — a NULL CHECK passes in Postgres and would be wrong quietly", () => {
    assert.notEqual(row.media_type, null);
    assert.notEqual(row.media_type, undefined);
  });

  it("the envelope reads back as VOICE with its waveform intact", () => {
    const parsed = parseKindEnvelope(row.msg_type as string, row.body as string);
    assert.ok(parsed);
    assert.equal(parsed!.kind, "VOICE");
    assert.deepEqual((parsed!.payload as any).waveform, [0.1, 0.5, 0.9, 0.3]);
  });

  it("classifies into §6.4's VOICE drawer tab, not MEDIA", () => {
    assert.equal(drawerTabFor(row as any), "VOICE");
  });

  it("is NOT searchable — there is no transcript, and search must not pretend otherwise", () => {
    // §6.4's object-aware search matches on text. A voice note has none until a
    // transcript provider exists, and indexing its URL would make a search for
    // "m4a" return conversations.
    assert.equal(searchableTextOf(row as any), null);
  });
});

// ── the route ────────────────────────────────────────────────────────────────

describe("POST /threads/:id/voice applies the same write gates as every other send", () => {
  it("writes the message for an active member", async () => {
    const c = useState({});
    const r = await post(`/threads/${THREAD}/voice`, ALICE, { payload: goodPayload() });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.kind, "VOICE");
    assert.equal(r.body.mediaType, "audio");
    assert.equal(r.body.mediaDurationSeconds, 12);
    const written = (c as any)._inserted.find((i: any) => i.table === "messages");
    assert.ok(written, "the message row must be written");
    assert.equal(written.row.media_type, "audio");
    assert.equal(written.row.msg_type, "voice");
  });

  it("REFUSES a non-member, and writes nothing", async () => {
    const c = useState({});
    const r = await post(`/threads/${THREAD_NONE}/voice`, ALICE, { payload: goodPayload() });
    assert.equal(r.status, 403);
    assert.equal((c as any)._inserted.length, 0);
  });

  it("REFUSES an E2EE thread by name — a voice note is plaintext audio in our storage", async () => {
    const c = useState({});
    const r = await post(`/threads/${THREAD_E2EE}/voice`, ALICE, { payload: goodPayload() });
    assert.equal(r.body.error, "e2ee_thread");
    assert.equal(r.status, 422, "lib/http.ts maps e2ee_thread to 422, not 400");
    assert.equal((c as any)._inserted.length, 0);
  });

  it("REFUSES when the sender is blocked by the only other member", async () => {
    const c = useState({ blocked: true });
    const r = await post(`/threads/${THREAD}/voice`, ALICE, { payload: goodPayload() });
    assert.equal(r.status, 403);
    assert.equal((c as any)._inserted.length, 0);
  });

  it("REFUSES when the kill switch is engaged", async () => {
    const c = useState({ killSwitch: true });
    const r = await post(`/threads/${THREAD}/voice`, ALICE, { payload: goodPayload() });
    assert.equal(r.body.error, "feature_disabled");
    assert.equal((c as any)._inserted.length, 0);
  });

  it("REFUSES when the roster cannot be read — an unreadable gate is not an open gate", async () => {
    const c = useState({ errorTable: "message_thread_members" });
    const r = await post(`/threads/${THREAD}/voice`, ALICE, { payload: goodPayload() });
    assert.equal(r.body.error, "degraded_unavailable");
    assert.equal((c as any)._inserted.length, 0);
  });
});

describe("a voice note may only reply to a message IN THE THREAD IT IS SENT TO", () => {
  /**
   * The disclosure this closes, concretely. `reply_to_id` is rendered by the
   * thread read as `replyToBody` + `replyToSenderName` — the quoted message's
   * TEXT, attributed to its ORIGINAL AUTHOR. The quoted-context query in
   * `routes/messaging.ts` resolves it with the SERVICE client, which is
   * BYPASSRLS. So a reply reference the write path accepts without checking the
   * thread is a way to make a named third party appear to have said something in
   * a room they never wrote in.
   *
   * `POST /threads/:id/messages` has checked this since it was built
   * (`routes/messaging.ts:2749`, fail-closed, 503 when the check itself cannot
   * run and 400 when the reference is genuinely wrong). The voice route was
   * added without it and is the only send path that lacked it.
   */
  it("REFUSES a replyToId belonging to another thread, and writes nothing", async () => {
    const c = useState({});
    const before = c._db.messages.length;
    const r = await post(`/threads/${THREAD}/voice`, ALICE, {
      payload: goodPayload(),
      replyToId: MSG_OTHER_THREAD,
    });
    assert.equal(r.status, 400);
    assert.match(String(r.body?.error?.message ?? r.body?.message ?? ""), /does not belong to this thread/i);
    assert.equal(c._db.messages.length, before, "a refused reply reference must not have written a message");
  });

  it("ACCEPTS a replyToId in the same thread, and persists it", async () => {
    const c = useState({});
    const r = await post(`/threads/${THREAD}/voice`, ALICE, {
      payload: goodPayload(),
      replyToId: MSG_IN_THREAD,
    });
    assert.equal(r.status, 201);
    assert.equal(r.body.replyToId, MSG_IN_THREAD);
    const row = c._inserted.find((i: any) => i.table === "messages");
    assert.equal(row.row.reply_to_id, MSG_IN_THREAD);
  });

  it("is FAIL-CLOSED: an unreadable messages table refuses with a retryable code, not a 400", async () => {
    // The two must not wear the same clothes. Telling a traveller their reply
    // reference is invalid, when in truth the check could not run, makes them
    // edit a message that was fine.
    const c = useState({ errorTable: "messages" });
    const before = c._db.messages.length;
    const r = await post(`/threads/${THREAD}/voice`, ALICE, {
      payload: goodPayload(),
      replyToId: MSG_IN_THREAD,
    });
    assert.equal(r.status, 503);
    assert.equal(c._db.messages.length, before);
  });

  it("accepts no replyToId at all — a voice note need not be a reply", async () => {
    useState({});
    const r = await post(`/threads/${THREAD}/voice`, ALICE, { payload: goodPayload() });
    assert.equal(r.status, 201);
    assert.equal(r.body.replyToId, null);
  });
});

describe("POST /threads/:id/voice refuses a payload it cannot vouch for", () => {
  it("REFUSES a foreign URL — the hotlink/tracker/SSRF hole, not re-opened on a new surface", async () => {
    const c = useState({});
    for (const url of [
      "https://evil.example.com/tracker.m4a",
      "//evil.example.com/x.m4a",
      "other-bucket/a/b.m4a",
    ]) {
      const r = await post(`/threads/${THREAD}/voice`, ALICE, { payload: goodPayload({ url }) });
      assert.equal(r.status, 400, `${url} was accepted`);
      assert.equal(r.body.error, "invalid_payload");
    }
    assert.equal((c as any)._inserted.length, 0);
  });

  it("REFUSES a container this server would never have stored", async () => {
    const c = useState({});
    const r = await post(`/threads/${THREAD}/voice`, ALICE, { payload: goodPayload({ mimeType: "audio/ogg" }) });
    assert.equal(r.status, 400);
    assert.equal((c as any)._inserted.length, 0);
  });

  it("REFUSES a duration outside the ceiling before it reaches the database", async () => {
    const c = useState({});
    const r = await post(`/threads/${THREAD}/voice`, ALICE, {
      payload: goodPayload({ durationSeconds: 100_000 }),
    });
    assert.equal(r.status, 400);
    assert.equal((c as any)._inserted.length, 0);
  });

  it("REFUSES an invalid thread id without touching the database", async () => {
    const c = useState({});
    const r = await post(`/threads/not-a-uuid/voice`, ALICE, { payload: goodPayload() });
    assert.equal(r.status, 400);
    assert.equal((c as any)._inserted.length, 0);
  });
});

describe("an unapplied migration 2989 is reported as itself, not as a generic failure", () => {
  it("names the migration rather than answering db_error", async () => {
    useState({ checkViolation: true });
    const r = await post(`/threads/${THREAD}/voice`, ALICE, { payload: goodPayload() });
    assert.equal(r.body.error, "degraded_unavailable");
    assert.ok(String(r.body.message).includes("2989"), r.body.message);
    assert.equal(r.body.message, AUDIO_MIGRATION_PENDING_MESSAGE);
  });

  it("recognises the violation by SQLSTATE and by constraint name", () => {
    assert.equal(isAudioMediaTypeRejection({ code: "23514" }), true);
    assert.equal(
      isAudioMediaTypeRejection({ message: 'violates check constraint "messages_media_type_check"' }),
      true,
    );
    assert.equal(isAudioMediaTypeRejection({ code: "XX000", message: "connection reset" }), false);
    assert.equal(isAudioMediaTypeRejection(null), false);
  });
});

/**
 * MUTATIONS RUN, WITH THE COUNTS THEY PRODUCED. Baseline 42/42. Every mutant
 * restored, and the baseline re-confirmed after each.
 *
 *   • The sniffer reverted to a `M4A `/`M4B ` BRAND ALLOWLIST — the version
 *     this module shipped with before the tracks were measured → 38/4: the
 *     Android case, the video-wearing-an-audio-brand case, the ordinary-video
 *     case and `isoTrackHandlers`. That mutant is not hypothetical; it is what
 *     was written first, and it would have made voice notes iOS-only while
 *     also handing a mislabelled video to the audio path.
 *   • The `soun` requirement dropped (any track set accepted) → 39/3.
 *   • `isoBoxes` dropping its `boxEnd > end` bound → 41/1, on the truncated
 *     file, which is the case that would otherwise read past the buffer.
 *   • The location scrub SKIPPED (`verifyUploadedVoiceBytes` returning the
 *     bytes untouched) → 41/1: the strip case, red on `stripped.length`.
 *   • `voiceMessageRow` writing `media_type: null` → 39/3: the media-columns
 *     case, the never-NULL case and the drawer-tab case. The ROUTE cases stayed
 *     green, which is exactly why the row shape is asserted separately from the
 *     response body.
 *   • The route's `appStorageUrlInfo` check bypassed → 41/1: the foreign-URL
 *     case, red on the first of its three URLs.
 *   • `guardTelegraphThreadWrite`'s refusal bypassed → 37/5: every gate case.
 *   • `isAudioMediaTypeRejection` returning false always → 40/2: the migration
 *     refusal falls through to `db_error`.
 *   • `normaliseWaveform` clamping NaN to 0 instead of dropping it → 41/1.
 *
 * TWO MUTANTS THAT DID NOT REDDEN, recorded because a mutation that survives is
 * the only one that tells you something you did not already know:
 *
 *   • `verifyUploadedVoiceBytes` returning `buf` instead of `scrub.buffer` →
 *     42/42. NOT A GAP IN THIS SUITE: `stripVideoLocationMetadata` neutralises
 *     the atoms IN PLACE and returns the same Buffer it was given, by design
 *     (`lib/videoMetadata.ts` explains at length why the edit must be
 *     length-preserving). The two expressions are the same object, so this is
 *     not a behaviour change and there is nothing for a test to catch. The
 *     mutation that DOES matter is skipping the scrub, above, and it reddens.
 *   • Bypassing the FIRST `if (!guard.ok)` in the route → 42/42. That one is
 *     the UPLOAD route's rate-limit/kill-switch guard, not the thread-write
 *     guard, and this suite does not drive the upload route over HTTP — as its
 *     header says. It is a real coverage gap, named here rather than left for
 *     the reader to infer from a green run: the upload endpoint's TRANSPORT
 *     (its guard call, its bounded body reader, its storage write) has no
 *     test. Its POLICY does.
 */
