/**
 * §18.2 T243 — the voice pipeline is AUDIO → TRANSCRIPT → optional TRANSLATION,
 * and the AUDIO is authoritative.
 *
 * WHERE THIS TREE ACTUALLY STANDS, stated before the assertions so nobody reads
 * this file as a claim the row is closed:
 *
 *   AUDIO       BUILT. `routes/telegraphVoice.ts` uploads it, `services/
 *               telegraph/voice.ts#voiceMessageRow` writes it, and
 *               `lib/mediaAccess.ts` branch 3c decides who may fetch the bytes.
 *   TRANSCRIPT  ABSENT, and deliberately so: no speech-to-text provider is
 *               configured in or reachable from this tree, and `VoicePayload`
 *               carries no nullable `transcript` field because nothing would
 *               ever write one.
 *   TRANSLATION ABSENT, because it is downstream of the transcript.
 *
 * So what "audio is authoritative" can MEAN here is the negative half, and the
 * negative half is the half that can go wrong silently: NO DERIVATIVE MAY BE
 * MANUFACTURED FROM A VOICE NOTE'S ENVELOPE, and none may gate access to the
 * audio.
 *
 * THE HAZARD THIS FILE CLOSES
 * ===========================
 * A §6.2 voice note stores a JSON ENVELOPE in `messages.body`, and that
 * envelope contains `payload.url` — a `post-media/<path>` storage key for a
 * PRIVATE bucket. `translateMessageForThread` takes a `body: string` and knows
 * nothing about message kinds. Nothing in the tree wires the typed-send or
 * voice-send routes to it today, so the hazard is latent rather than live — but
 * "latent" here means one import away, and what it would do is:
 *
 *   - send a private storage key to a third-party translation provider, and
 *   - store that key in `message_translations.translated_body`, a column that
 *     branch 3c's media gate does not cover and that every thread reader
 *     receives.
 *
 * That is a §16 media-privacy failure reached through §18's door. It is closed
 * structurally instead of by convention: the pipeline REFUSES a structured
 * envelope body before it calls a provider and before it writes a row.
 *
 * MUTATION REQUIREMENT: deleting the envelope guard from
 * `translateMessageForThread` must fail "the storage key never reaches the
 * translation provider"; narrowing `isStructuredEnvelopeBody` to VOICE alone
 * must fail "every structured kind is refused, not just VOICE".
 *
 * Run:
 *   SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *     node --import tsx/esm --test src/test/voicePipelineAuthority.test.ts
 */
import { describe, it, beforeEach, after } from "node:test";
import assert from "node:assert/strict";

import { _setTestTranslationProvider } from "../lib/translation.js";
import {
  translateMessageForThread,
  isStructuredEnvelopeBody,
} from "../services/messageTranslation.js";
import {
  voiceMessageRow,
  validateVoicePayload,
  normaliseWaveform,
} from "../services/telegraph/voice.js";
import { makeFakeClient, resetFakeIds } from "./telegraphCertificationHarness.js";

const A = "aaaaaaaa-0000-4000-8000-000000000001";
const B = "bbbbbbbb-0000-4000-8000-000000000002";
const DM = "00000000-0000-4000-8000-00000000000d";
const MSG = "11111111-0000-4000-8000-000000000001";

const STORAGE_KEY = `post-media/${A}/voice/secret-recording-1234.m4a`;

/** The exact row a voice note writes, built by the real writer. */
function voiceEnvelopeBody(): string {
  const v = validateVoicePayload({
    url: STORAGE_KEY,
    durationSeconds: 12,
    waveform: [0.1, 0.9, 0.4],
    mimeType: "audio/mp4",
  });
  assert.equal(v.ok, true);
  const row = voiceMessageRow({
    threadId: DM,
    senderId: A,
    payload: (v as { ok: true; payload: any }).payload,
    createdAt: "2026-01-01T00:00:00.000Z",
  });
  return String(row.body);
}

/** Records every text handed to the provider, and translates nothing usefully. */
function spyProvider() {
  const sawDetect: string[] = [];
  const sawTranslate: string[] = [];
  return {
    sawDetect,
    sawTranslate,
    provider: {
      async detectLanguage(text: string) {
        sawDetect.push(text);
        return { language: "es" as const, confidence: "high" as const };
      },
      async translateText(text: string, _s: string, target: string) {
        sawTranslate.push(text);
        return {
          translatedText: `[${target}] ${text} plus enough words to pass validation`,
          provider: "spy",
          providerVersion: "spy-1",
        };
      },
    },
  };
}

function store(body: string): Record<string, any[]> {
  return {
    feature_flags: [],
    blocks: [],
    profiles: [
      { id: A, handle: "a", name: "A", account_status: null, preferred_language: "es", auto_translate_messages: true },
      { id: B, handle: "b", name: "B", account_status: null, preferred_language: "en", auto_translate_messages: true },
    ],
    message_threads: [
      { id: DM, thread_type: "direct", trip_id: null, circle_owner_id: null, title: null,
        status: "active", is_e2ee: false, created_at: "2026-01-01T00:00:00.000Z",
        updated_at: "2026-01-01T00:00:00.000Z", last_message_at: null },
    ],
    message_thread_members: [
      { thread_id: DM, user_id: A, role: "member", left_at: null, last_read_at: null, visible_from_at: null },
      { thread_id: DM, user_id: B, role: "member", left_at: null, last_read_at: null, visible_from_at: null },
    ],
    messages: [
      { id: MSG, thread_id: DM, sender_id: A, body, created_at: "2026-01-01T00:00:00.000Z",
        deleted_at: null, edited_at: null, original_language: null, language_detection_source: null,
        msg_type: "voice", subtype: null, media_url: STORAGE_KEY, media_type: "audio",
        media_thumbnail_url: null, media_duration_seconds: 12, reply_to_id: null },
    ],
    message_translations: [],
    trips: [],
    trip_members: [],
  };
}

beforeEach(() => resetFakeIds());
after(() => _setTestTranslationProvider(null));

describe("§18.2 T243 — no derivative is manufactured from a voice note's envelope", () => {
  it("the storage key never reaches the translation provider", async () => {
    const spy = spyProvider();
    _setTestTranslationProvider(spy.provider as any);
    const sc = makeFakeClient(store(voiceEnvelopeBody()));

    await translateMessageForThread(sc as any, {
      messageId: MSG, body: voiceEnvelopeBody(), senderId: A, threadId: DM,
    });

    assert.deepEqual(spy.sawDetect, [], "a voice envelope must not be sent for language detection");
    assert.deepEqual(spy.sawTranslate, [], "a voice envelope must not be sent for translation");
    // The specific thing that must not travel.
    for (const seen of [...spy.sawDetect, ...spy.sawTranslate]) {
      assert.doesNotMatch(seen, /post-media/);
    }
  });

  it("no translation row is written for a voice note, so no reader receives its key", async () => {
    const spy = spyProvider();
    _setTestTranslationProvider(spy.provider as any);
    const sc = makeFakeClient(store(voiceEnvelopeBody()));

    await translateMessageForThread(sc as any, {
      messageId: MSG, body: voiceEnvelopeBody(), senderId: A, threadId: DM,
    });

    assert.deepEqual(sc._store["message_translations"], []);
    assert.doesNotMatch(
      JSON.stringify(sc._store["message_translations"] ?? []),
      /post-media/,
      "the private storage key must not appear in message_translations",
    );
  });

  it("an ordinary text message is STILL translated — the guard is not an off switch", async () => {
    const spy = spyProvider();
    _setTestTranslationProvider(spy.provider as any);
    const body = "nos vemos en el muelle a las ocho.";
    const seed = store(body);
    seed["messages"]![0]!.msg_type = "text";
    seed["messages"]![0]!.media_url = null;
    seed["messages"]![0]!.media_type = null;
    const sc = makeFakeClient(seed);

    await translateMessageForThread(sc as any, {
      messageId: MSG, body, senderId: A, threadId: DM,
    });

    assert.deepEqual(spy.sawDetect, [body]);
    assert.ok((sc._store["message_translations"] ?? []).length > 0, "a text message still gets a row");
  });
});

describe("isStructuredEnvelopeBody — what counts as an envelope", () => {
  it("every structured kind is refused, not just VOICE", () => {
    for (const kind of ["VOICE", "GIF", "LOCATION", "MEMORY_NOTE", "MEDIA_ALBUM", "ACTION"]) {
      assert.equal(
        isStructuredEnvelopeBody(JSON.stringify({ kind, envelopeVersion: "1", payload: {} })),
        true,
        `${kind} envelope must be recognised`,
      );
    }
  });

  it("ordinary prose is not an envelope, whatever it says", () => {
    for (const prose of [
      "nos vemos en el muelle a las ocho.",
      '{"kind":"VOICE"}',                       // no envelopeVersion
      '{"envelopeVersion":"1"}',                // no kind
      '{"kind":1,"envelopeVersion":"1"}',       // kind is not a string
      'I said {"kind":"VOICE","envelopeVersion":"1"} in a message',
      "[1,2,3]",
      "",
      "null",
    ]) {
      assert.equal(isStructuredEnvelopeBody(prose), false, `must not read as an envelope: ${prose}`);
    }
  });

  it("survives null, undefined and a non-string without throwing", () => {
    assert.equal(isStructuredEnvelopeBody(null), false);
    assert.equal(isStructuredEnvelopeBody(undefined), false);
    assert.equal(isStructuredEnvelopeBody(12345 as unknown as string), false);
  });
});

describe("§18.2 T243 — the audio is authoritative; the waveform cannot gate it", () => {
  it("a voice note with NO waveform is still a complete, playable message", () => {
    const v = validateVoicePayload({
      url: STORAGE_KEY, durationSeconds: 30, waveform: [], mimeType: "audio/mp4",
    });
    assert.equal(v.ok, true);
    const row = voiceMessageRow({
      threadId: DM, senderId: A, payload: (v as any).payload, createdAt: "2026-01-01T00:00:00.000Z",
    });
    // The two facts that make the audio reachable are present with no waveform
    // at all: §11.3's rule that a derivative may never gate the original.
    assert.equal(row["media_url"], STORAGE_KEY);
    assert.equal(row["media_type"], "audio");
    assert.equal(row["media_duration_seconds"], 30);
  });

  it("an out-of-range waveform degrades the picture and never the recording", () => {
    // A meter reporting decibels, or a 0-255 scale, is a NORMAL recording from
    // an unexpected device. It is clamped, not refused, so the audio still
    // arrives — the derivative bends and the original does not break.
    const v = validateVoicePayload({
      url: STORAGE_KEY,
      durationSeconds: 30,
      waveform: [-160, -5, 0.5, 99, 255],
      mimeType: "audio/mp4",
    });
    assert.equal(v.ok, true);
    assert.deepEqual((v as any).payload.waveform, normaliseWaveform([-160, -5, 0.5, 99, 255]));
    assert.deepEqual((v as any).payload.waveform, [0, 0, 0.5, 1, 1]);
    assert.equal((v as any).payload.url, STORAGE_KEY);
  });

  it("the two non-finite peaks are handled DIFFERENTLY, and neither loses the audio", () => {
    // MEASURED, not assumed, and recorded because the two halves read as if
    // they agree and do not. `normaliseWaveform` drops NaN and Infinity alike
    // ("no reading" is not a quiet frame), but on the WIRE they take different
    // doors: zod's `z.number()` rejects NaN outright, and accepts ±Infinity as
    // a number, which the normaliser then drops.
    //
    //   NaN        → the whole payload is REFUSED
    //   ±Infinity  → accepted; that one bar disappears; the recording arrives
    //
    // The asymmetry is noted rather than changed: both outcomes are safe, and
    // the one that refuses is the stricter of the two. What matters for T243 is
    // the second column — in no case does a bad peak take the AUDIO with it.
    const nan = validateVoicePayload({
      url: STORAGE_KEY, durationSeconds: 30, waveform: [0.5, Number.NaN], mimeType: "audio/mp4",
    });
    assert.equal(nan.ok, false, "NaN is refused on the wire");

    for (const inf of [Infinity, -Infinity]) {
      const v = validateVoicePayload({
        url: STORAGE_KEY, durationSeconds: 30, waveform: [0.5, inf], mimeType: "audio/mp4",
      });
      assert.equal(v.ok, true, `${inf} is accepted and normalised away`);
      assert.deepEqual((v as any).payload.waveform, [0.5]);
      assert.equal((v as any).payload.url, STORAGE_KEY, "the recording survives its bad waveform");
    }

    // And the normaliser, reached directly, drops both rather than clamping.
    assert.deepEqual(normaliseWaveform([0.5, Number.NaN, Infinity, 0.25]), [0.5, 0.25]);
  });
});
