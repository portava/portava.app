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
 * sniffer, and BOTH real `routes/telegraphVoice.ts` paths — the SEND path and
 * the UPLOAD path — mounted in an express app over an in-memory
 * PostgREST-shaped fake.
 *
 * THE UPLOAD ROUTE'S POLICY AND ITS TRANSPORT ARE TESTED SEPARATELY, AND THE
 * SPLIT IS DELIBERATE. The POLICY — the declared-MIME allowlist, the byte
 * sniff, the size ceiling, the fail-closed location scrub — is exercised
 * directly against the functions that decide it, because that is where the
 * decisions live. The TRANSPORT around those decisions is exercised over real
 * HTTP at the bottom of this file: the bounded body reader (a body read in
 * full, a body at exactly the ceiling, a body one byte over it refused by the
 * BOUND rather than by anything downstream, and a 64 MB body refused
 * mid-stream rather than buffered), the `guardUploadRequest` call (its kill
 * switch, its fail-closed flag read, and the SHARED per-user bucket a caller
 * must not be able to refill by switching endpoints), and the storage write
 * (the object's bucket, its path under the caller's own prefix, its sniffed
 * content type, the scrubbed bytes it carries — and a FAILED write, which
 * supabase-js reports by RESOLVING with `{ data: null, error }`, surfaced as a
 * failure rather than as a 201 naming an object that was never stored).
 *
 * The storage client is the same injected fake the rest of the file uses
 * (`_setTestClient` installs it as the service client as well), carrying an
 * upload recorder. Standing up a fake bucket to assert a fake's return value
 * would indeed test the fake; asserting WHICH BYTES the route handed it, under
 * WHICH KEY, is a fact about the route.
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
import { createServer, request as httpRequest } from "node:http";
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
  guardUploadRequest,
  UPLOAD_RATE_LIMIT,
  validateDeclaredVoiceUpload,
  verifyUploadedVoiceBytes,
  VOICE_SIZE_LIMIT,
} from "../lib/mediaPipeline.js";
import { _resetRateLimit } from "../lib/rateLimit.js";
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

/**
 * A VALID voice note of EXACTLY `total` bytes, padded with a `free` box.
 *
 * `free` is the ISO-BMFF box whose contents are defined to be ignorable, so
 * padding with one keeps the file a real, walkable container: the size is the
 * only thing that changes. Needed because the bounded reader's behaviour is a
 * function of LENGTH, and a fixture that stopped being a voice note at 8 MB
 * would prove the sniffer refused it, not that the reader did.
 */
function m4aOfSize(total: number): Buffer {
  const core = m4aIos();
  const padBody = total - core.length - 8;
  assert.ok(padBody >= 0, `cannot build a voice note as small as ${total} bytes`);
  return Buffer.concat([core, box("free", Buffer.alloc(padBody))]);
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
  /**
   * `disable_media_uploads` — the UPLOAD kill switch, which is a DIFFERENT flag
   * from `disable_messaging` above. `guardUploadRequest` reads this one.
   */
  uploadKillSwitch?: boolean;
  /**
   * Make the storage write resolve with an error, the way supabase-js reports a
   * failed upload: it RESOLVES with `{ data: null, error }` rather than throwing,
   * so a route that ignores `error` reports a success that never happened.
   */
  storageError?: boolean;
}

function fixture(state: State): Record<string, any[]> {
  return {
    feature_flags: [
      { flag: "disable_messaging", enabled: state.killSwitch === true },
      { flag: "disable_media_uploads", enabled: state.uploadKillSwitch === true },
    ],
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

  /**
   * Every storage call this client was asked to make, in order. The upload
   * route's only side effect is the object it writes, so the test asserts on
   * THIS — what was written, where, and with which content type — rather than
   * on the 201 the handler returned.
   */
  const uploads: Array<{
    bucket: string;
    path: string;
    body: Buffer;
    options: Record<string, unknown>;
  }> = [];

  const storage = {
    from(bucket: string) {
      return {
        // supabase-js RESOLVES on a failed upload. The fake does the same, so a
        // route that drops `error` would be caught here rather than flattered.
        async upload(path: string, body: Buffer, options: Record<string, unknown>) {
          uploads.push({ bucket, path, body, options });
          if (state.storageError) {
            return { data: null, error: { message: "bucket post-media not found", statusCode: "404" } };
          }
          return { data: { path }, error: null };
        },
      };
    },
  };

  return {
    _db: db,
    _inserted: inserted,
    _uploads: uploads,
    storage,
    from,
    rpc: async () => ({ data: null, error: { message: "rpc not modelled" } }),
    auth: { getUser: async (token: string) => ({ data: { user: { id: token } }, error: null }) },
  };
}

let server: ReturnType<typeof createServer>;
let base = "";

function useState(state: State) {
  const c = makeClient(state);
  _setTestClient(c, true); _resetRateLimit(); // the §22 send limiter is PROCESS state and now guards this door too: without this the 21st send in the FILE is a 429 that measures an earlier case
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

/**
 * Drive the UPLOAD route over real HTTP with raw bytes.
 *
 * `asUser: null` sends NO Authorization header, which is how the bounded
 * reader's refusal is told apart from every refusal downstream of it: the
 * reader runs BEFORE `requireUser`, so an unauthenticated over-limit request
 * that comes back `invalid_payload` can only have been refused by the bound,
 * while one that comes back `unauthenticated` reached the handler with the
 * whole body buffered.
 */
async function upload(
  bytes: Buffer,
  opts: { asUser?: string | null; contentType?: string } = {},
) {
  const headers: Record<string, string> = { "content-type": opts.contentType ?? "audio/mp4" };
  const asUser = opts.asUser === undefined ? ALICE : opts.asUser;
  if (asUser !== null) headers.authorization = `Bearer ${asUser}`;
  const r = await fetch(`${base}/telegraph/voice/upload`, { method: "POST", headers, body: bytes });
  const text = await r.text();
  let parsed: any = null;
  try { parsed = JSON.parse(text); } catch { parsed = text; }
  return { status: r.status, body: parsed, retryAfter: r.headers.get("retry-after") };
}

/**
 * Send a body of `declaredTotal` bytes a megabyte at a time, and report how
 * many bytes the client actually got to write before the server stopped
 * listening. Used to prove the reader refuses MID-STREAM rather than
 * accumulating the whole upload and measuring it afterwards.
 */
function uploadStreaming(declaredTotal: number, chunkSize: number) {
  return new Promise<{ status: number | null; body: any; bytesWritten: number }>((resolve, reject) => {
    const chunk = Buffer.alloc(chunkSize);
    const url = new URL(`${base}/telegraph/voice/upload`);
    const req = httpRequest(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        method: "POST",
        headers: {
          authorization: `Bearer ${ALICE}`,
          "content-type": "audio/mp4",
          "content-length": String(declaredTotal),
        },
      },
      (res) => {
        const parts: Buffer[] = [];
        res.on("data", (c: Buffer) => parts.push(c));
        res.on("end", () => {
          stop = true;
          const text = Buffer.concat(parts).toString("utf8");
          let parsed: any = null;
          try { parsed = JSON.parse(text); } catch { parsed = text; }
          settle({ status: res.statusCode ?? null, body: parsed, bytesWritten });
        });
      },
    );

    let bytesWritten = 0;
    let stop = false;
    let settled = false;
    const settle = (v: { status: number | null; body: any; bytesWritten: number }) => {
      if (settled) return;
      settled = true;
      resolve(v);
    };
    // The socket being torn down under us is the EXPECTED end of this write, not
    // a test failure: the route destroys the request once the bound is passed.
    req.on("error", () => { stop = true; settle({ status: null, body: null, bytesWritten }); });
    setTimeout(() => { stop = true; req.destroy(); reject(new Error("no answer from the upload route")); }, 10_000).unref();

    const pump = () => {
      while (!stop && bytesWritten < declaredTotal) {
        bytesWritten += chunk.length;
        if (!req.write(chunk)) {
          req.once("drain", pump);
          return;
        }
      }
      if (!stop) req.end();
    };
    pump();
  });
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

// ── the upload route's TRANSPORT ─────────────────────────────────────────────
//
// The POLICY above is exercised directly; what follows drives the UPLOAD route
// over real HTTP, which is the only way to reach the three things the policy
// tests cannot see: the bounded body reader, the `guardUploadRequest` call, and
// the storage write. The storage client is the same injected fake the rest of
// this file uses (`_setTestClient` installs it as the service client too), with
// an upload recorder on it — so these assert on WHAT WAS WRITTEN, not on 201.

describe("the upload route's bounded body reader", () => {
  it("reads a multi-chunk body in FULL — every chunk, in order, nothing dropped", async () => {
    // A megabyte arrives as many `data` events over loopback, so a reader that
    // kept only the last chunk, or lost one, cannot pass this: the bytes that
    // reach storage are compared against the bytes that were sent.
    _resetRateLimit();
    const c = useState({});
    const sent = m4aOfSize(1024 * 1024);
    const r = await upload(sent);
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(c._uploads.length, 1, "exactly one object must have been written");
    const written: Buffer = c._uploads[0].body;
    assert.equal(written.length, sent.length, "the stored object is a different length to the body sent");
    assert.ok(Buffer.isBuffer(written) && written.equals(sent), "the stored bytes are not the bytes sent");
    assert.equal(r.body.sizeBytes, sent.length);
  });

  it("accepts a body of EXACTLY the ceiling — the bound is `>`, not `>=`", async () => {
    // The off-by-one that would refuse a legal 8 MB recording.
    _resetRateLimit();
    const c = useState({});
    const sent = m4aOfSize(VOICE_SIZE_LIMIT);
    const r = await upload(sent);
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(c._uploads.length, 1);
    assert.equal(c._uploads[0].body.length, VOICE_SIZE_LIMIT);
  });

  it("REFUSES one byte over the ceiling — and the READER refuses it, before authentication", async () => {
    // WHY THE REQUEST IS UNAUTHENTICATED. `validateDeclaredVoiceUpload` refuses
    // an over-sized body too, with the SAME sentence, so a refusal from an
    // authenticated request would not say which code produced it. The reader
    // runs as middleware, ahead of `requireUser`; the declared-size check runs
    // after it. Sending no Authorization header therefore separates them: this
    // answer can only come from the bound. Had the bound not fired, the body
    // would have been buffered and `requireUser` would have answered
    // `unauthenticated`.
    _resetRateLimit();
    const c = useState({});
    const r = await upload(m4aOfSize(VOICE_SIZE_LIMIT + 1), { asUser: null });
    assert.equal(r.body?.error, "invalid_payload", `refused by the wrong code: ${JSON.stringify(r.body)}`);
    assert.match(String(r.body?.message ?? ""), /too large/i);
    assert.ok(String(r.body?.message ?? "").includes("8 MB"), r.body?.message);
    assert.equal(c._uploads.length, 0, "an over-sized body must not reach storage");
  });

  it("refuses MID-STREAM rather than buffering the upload and measuring it after", async () => {
    // The property the bound exists for, stated as the thing that would be
    // false without it: a 64 MB body is refused having transferred a fraction
    // of itself, because the socket is destroyed the moment the accumulated
    // length passes the ceiling. An unbounded reader would answer only after
    // all 64 MB were in memory.
    _resetRateLimit();
    const c = useState({});
    const declared = 64 * 1024 * 1024;
    const r = await uploadStreaming(declared, 1024 * 1024);
    assert.ok(
      r.bytesWritten < declared,
      `the whole ${declared}-byte body was transferred: the reader is not bounded`,
    );
    assert.ok(
      r.bytesWritten < VOICE_SIZE_LIMIT * 4,
      `refused only after ${r.bytesWritten} bytes, far past the ${VOICE_SIZE_LIMIT}-byte ceiling`,
    );
    // The connection may be torn down before the refusal lands — that is the
    // bound working. What must NOT happen is the upload succeeding.
    assert.notEqual(r.status, 201, "an over-sized upload reported success");
    if (r.status !== null) assert.equal(r.body?.error, "invalid_payload", JSON.stringify(r.body));
    assert.equal(c._uploads.length, 0, "an over-sized body must not reach storage");
  });
});

describe("the upload route calls guardUploadRequest, and honours its verdict", () => {
  it("REFUSES when the UPLOAD kill switch is engaged, and writes no object", async () => {
    // `disable_media_uploads`, not `disable_messaging`: the guard the route
    // calls is the shared media-upload guard, and this is the flag it reads.
    _resetRateLimit();
    const c = useState({ uploadKillSwitch: true });
    const r = await upload(m4aIos());
    assert.equal(r.body?.error, "feature_disabled", JSON.stringify(r.body));
    assert.equal(r.status, 404, "lib/http.ts maps feature_disabled to 404");
    assert.equal(c._uploads.length, 0, "a refused upload must not write an object");
  });

  it("is FAIL-CLOSED: an unreadable flag table refuses the upload rather than admitting it", async () => {
    _resetRateLimit();
    const c = useState({ errorTable: "feature_flags" });
    const r = await upload(m4aIos());
    assert.equal(r.body?.error, "feature_disabled", JSON.stringify(r.body));
    assert.equal(c._uploads.length, 0);
  });

  it("shares the per-user upload BUDGET — an exhausted bucket refuses this endpoint too", async () => {
    // The whole reason the policy lives in `lib/mediaPipeline.ts`: a caller must
    // not get a fresh allowance by switching to the voice endpoint. The bucket
    // is exhausted here through `guardUploadRequest` DIRECTLY — the same
    // function, the same bucket id the general transports call — and then the
    // voice endpoint is asked. If the route did not call the guard, this would
    // be a 201.
    _resetRateLimit();
    const c = useState({});
    for (let i = 0; i < UPLOAD_RATE_LIMIT; i++) {
      const g = await guardUploadRequest(c, ALICE);
      assert.equal(g.ok, true, `the bucket was exhausted early, at ${i}`);
    }
    const r = await upload(m4aIos());
    assert.equal(r.body?.error, "rate_limited", JSON.stringify(r.body));
    assert.equal(r.status, 429);
    // The guard's `retryAfterMs` has to reach the caller as a header, or a
    // client has nothing to wait on.
    assert.ok(r.retryAfter, "a rate-limited upload must carry Retry-After");
    assert.ok(Number(r.retryAfter) > 0, `Retry-After was ${r.retryAfter}`);
    assert.equal(c._uploads.length, 0, "a rate-limited upload must not write an object");
    _resetRateLimit();
  });

  it("the budget is PER USER — Bob exhausting his does not refuse Alice", async () => {
    // Proves the refusal above came from Alice's own bucket and not from a
    // global one, which would make one noisy client an outage for everyone.
    _resetRateLimit();
    const c = useState({});
    for (let i = 0; i < UPLOAD_RATE_LIMIT; i++) await guardUploadRequest(c, BOB);
    const r = await upload(m4aIos(), { asUser: ALICE });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(c._uploads.length, 1);
    _resetRateLimit();
  });
});

describe("the upload route's storage write is the thing that has to have happened", () => {
  it("writes the object to the private bucket under the CALLER'S prefix, as audio", async () => {
    _resetRateLimit();
    const c = useState({});
    const r = await upload(m4aIos());
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(c._uploads.length, 1, "nothing was written to storage");
    const [op] = c._uploads;
    assert.equal(op.bucket, "post-media");
    assert.match(
      op.path,
      new RegExp(`^${ALICE}/voice/\\d+\\.m4a$`),
      `an object at ${op.path} is not under the caller's own prefix`,
    );
    // The content type is the SNIFFED one, not the declared one: the bytes
    // decide here as well as at the gate.
    assert.equal(op.options.contentType, "audio/mp4");
    // `upsert: false` is what stops a second upload silently replacing an
    // object a message already references.
    assert.equal(op.options.upsert, false);
    // The response must name the object that was actually written — a path the
    // send route will later resolve.
    assert.equal(r.body.path, op.path);
    assert.equal(r.body.url, `post-media/${op.path}`);
    assert.equal(r.body.mimeType, "audio/mp4");
    assert.equal(r.body.sizeBytes, op.body.length);
    // And it must be an object the SEND route would accept as the caller's own.
    const sent = await post(`/threads/${THREAD}/voice`, ALICE, {
      payload: goodPayload({ url: r.body.url, mimeType: r.body.mimeType, sizeBytes: r.body.sizeBytes }),
    });
    assert.equal(sent.status, 201, JSON.stringify(sent.body));
  });

  it("stores the SCRUBBED bytes — the capture location is gone from what is written", async () => {
    // The scrub is tested directly above, on the return value. This asserts the
    // ROUTE stores what came back rather than the buffer it was handed: the
    // coordinates must not be in the object.
    _resetRateLimit();
    const c = useState({});
    const withLocation = m4aWithLocation();
    assert.ok(withLocation.includes(Buffer.from("+16.0678", "latin1")), "the fixture must carry a location");
    const r = await upload(withLocation);
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(c._uploads.length, 1);
    const written: Buffer = c._uploads[0].body;
    assert.ok(!written.includes(Buffer.from("+16.0678", "latin1")), "the stored object still names the capture location");
    assert.ok(!written.includes(Buffer.from("\u00a9xyz", "latin1")), "the stored object still carries the \u00a9xyz atom");
    assert.equal(written.length, withLocation.length, "the scrub must be length-preserving");
  });

  it("REFUSES a declared type the policy does not admit, over HTTP, without writing", async () => {
    _resetRateLimit();
    const c = useState({});
    const r = await upload(m4aIos(), { contentType: "audio/ogg" });
    assert.equal(r.body?.error, "invalid_payload", JSON.stringify(r.body));
    assert.equal(c._uploads.length, 0);
  });

  it("a FAILED storage write is surfaced as a FAILURE, not reported as success", async () => {
    // supabase-js RESOLVES with `{ data: null, error }` on a failed upload. A
    // route that destructured only `data` would answer 201 with a path to an
    // object that does not exist, and the message written against it would
    // render a broken player forever. So: the call must have been attempted,
    // and the answer must not be a success.
    _resetRateLimit();
    const c = useState({ storageError: true });
    const r = await upload(m4aIos());
    assert.equal(c._uploads.length, 1, "the route must have attempted the write");
    assert.notEqual(r.status, 201, "a failed storage write was reported as a success");
    assert.equal(r.body?.error, "db_error", JSON.stringify(r.body));
    assert.equal(r.status, 500, "lib/http.ts maps db_error to 500");
    // And it must not hand back a path to an object that was never stored.
    assert.equal(r.body?.path, undefined);
    assert.equal(r.body?.url, undefined);
  });
});

/**
 * MUTATIONS RUN, WITH THE COUNTS THEY PRODUCED. Baseline 42/42 when the suite
 * covered the send path alone; 58/58 with the upload transport added below.
 * Every mutant restored, and the baseline re-confirmed after each.
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
 *   • Bypassing the FIRST `if (!guard.ok)` in the route → 42/42, when this
 *     suite did not drive the upload route over HTTP. That gap is CLOSED: the
 *     same mutation now reads 55/3 (the upload kill switch, the fail-closed
 *     flag read and the shared-bucket case).
 *
 * MUTATIONS RUN FOR THE UPLOAD TRANSPORT, from the 58/58 baseline:
 *
 *   • `collectBody` keeping only the LAST chunk → 56/2: the multi-chunk read
 *     and the at-the-ceiling case. The mutant a single-chunk fixture would
 *     have missed entirely, which is why the body is a megabyte.
 *   • The bound changed from `>` to `>=` → 57/1: the at-the-ceiling case. A
 *     legal 8 MB recording refused.
 *   • The bound REMOVED (`if (false)`) → 56/2: the one-byte-over case and the
 *     mid-stream case. The one-byte-over request is sent UNAUTHENTICATED on
 *     purpose — `validateDeclaredVoiceUpload` refuses an over-sized body with
 *     the same sentence, so without that the two refusals are
 *     indistinguishable and the test would have proved nothing about the
 *     reader. Unbounded, the request reaches `requireUser` and comes back
 *     `unauthenticated`.
 *   • `guardUploadRequest`'s refusal bypassed → 55/3 (above).
 *   • The `Retry-After` header not set on a rate-limited upload → 57/1.
 *   • FIXTURE mutation: the per-user test exhausting ALICE's bucket instead of
 *     BOB's → 57/1. The fixture has to be able to produce the refusal, or
 *     "Bob's bucket does not refuse Alice" is a tautology.
 *   • The object written WITHOUT the caller's id prefix → 57/1.
 *   • The write's `contentType` replaced with `application/octet-stream` and
 *     `upsert` flipped to true → 57/1.
 *   • The declared-type refusal bypassed → 57/1 (over HTTP, not just in the
 *     policy unit test).
 *   • `if (upErr)` bypassed — the supabase-js resolves-on-error trap → 57/1:
 *     the failed-write case, red on the 201 it would have answered.
 *   • The location scrub skipped inside `verifyUploadedVoiceBytes` → 56/2: the
 *     direct strip case AND the route case that asserts the STORED bytes no
 *     longer name the coordinates.
 *
 * ONE MORE THAT DID NOT REDDEN, and the reason is already recorded above:
 *
 *   • The route storing `raw` instead of `buffer` → 58/58. Same cause as the
 *     `verifyUploadedVoiceBytes` mutant above: `stripVideoLocationMetadata`
 *     neutralises the atoms IN PLACE and returns the Buffer it was given, so
 *     `raw` and `buffer` are the same object and no behaviour changes. The
 *     mutation that DOES matter is skipping the scrub, and it reddens the
 *     route case too.
 */
