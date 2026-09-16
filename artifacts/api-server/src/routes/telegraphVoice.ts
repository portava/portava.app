/**
 * Telegraph §6.2 VOICE — the upload door and the send door.
 *
 *   POST /api/telegraph/voice/upload
 *        Raw M4A bytes in, a storage path out. Same shape as
 *        `POST /api/media/upload`, a strictly narrower policy, and the SAME
 *        per-user rate-limit bucket.
 *
 *   POST /api/threads/:threadId/voice
 *        Writes the §6.2 VOICE message: the envelope in `body` AND the media
 *        columns, which is why this is not `POST /threads/:id/typed-messages`
 *        (see `services/telegraph/messageKinds.ts`'s header).
 *
 * ── WHY A SECOND UPLOAD ENDPOINT AND NOT A WIDER FIRST ONE ──────────────────
 * `POST /api/media/upload` serves posts, memories and stories. Teaching it
 * audio would have meant adding an audio type to `ALLOWED_MEDIA_MIME`, which
 * every one of those surfaces reads — so a change made for messaging would have
 * silently widened what a post accepts. This endpoint is reachable only by a
 * caller that asks for it, admits ONE container, and caps at 8 MB rather than
 * 100.
 *
 * It does NOT get a fresh rate-limit allowance: `guardUploadRequest` is the same
 * function with the same bucket id that both general transports call, so an
 * abusive client cannot double its upload budget by alternating endpoints. That
 * property is the entire reason the policy lives in `lib/mediaPipeline.ts`
 * rather than here.
 *
 * ── AUTHORIZATION ───────────────────────────────────────────────────────────
 * The send path applies `guardTelegraphThreadWrite` — the same four gates, in
 * the same order, as the ordinary send path and the §5 share route: the
 * `disable_messaging` kill switch (fail-closed), ACTIVE membership, the 1:1
 * block guard (whose roster read is checked, so an unreadable roster cannot
 * make the guard unreachable), and the E2EE refusal. A voice note is plaintext
 * audio in our storage; an E2EE thread's promise is that the server never holds
 * plaintext, so it is refused by name rather than quietly written.
 *
 * The UPLOAD path is authenticated but deliberately NOT thread-scoped, exactly
 * as `/api/media/upload` is not. Binding the object to a thread at upload time
 * would prove nothing — the send call re-checks membership at write time, which
 * is the moment that matters, and is the check a caller cannot skip.
 *
 * The send path ALSO checks that the object is the caller's own, which is a
 * different question from membership and from origin. See the comment above
 * `classifyMemoryMediaUrl` in the send handler: `post-media` is private, and
 * `lib/mediaAccess.ts` branch 3c turns "a message references this object"
 * into read access for every member of that message's thread without ever
 * asking who owned it.
 */
import { Router } from "express";
import { requireUser, sendError } from "../lib/http.js";
import { asyncHandler } from "../lib/asyncHandler.js";
import { logger as rootLogger } from "../lib/logger.js";
import { getServiceClient } from "../lib/supabase.js";
import { appStorageUrlInfo } from "../lib/mediaUrl.js";
import { guardTelegraphThreadWrite } from "../lib/telegraphThreadWrite.js";
import { classifyMemoryMediaUrl } from "../services/memory/memoryMediaOrigin.js";
import { publishToThread } from "../lib/telegraphEvents.js";
import {
  ALLOWED_VOICE_MIME,
  guardUploadRequest,
  validateDeclaredVoiceUpload,
  verifyUploadedVoiceBytes,
  VOICE_SIZE_LIMIT,
} from "../lib/mediaPipeline.js";
import {
  AUDIO_MIGRATION_PENDING_MESSAGE,
  isAudioMediaTypeRejection,
  validateVoicePayload,
  voiceMessageRow,
  VOICE_MAX_DURATION_SECONDS,
  WAVEFORM_MAX_PEAKS,
} from "../services/telegraph/voice.js";

const log = rootLogger.child({ route: "telegraphVoice" });
const router = Router();

const UUID = /^[0-9a-f-]{36}$/i;
const STORAGE_BUCKET = "post-media";

/**
 * The refusal shown when a voice note names an object belonging to someone
 * else. Deliberately in this file rather than reused from the memories surface:
 * `FOREIGN_MEDIA_REFUSAL` tells the user to add a photo to a Memory, which is
 * the wrong instruction here. The CHECK is shared; the sentence is not.
 */
const FOREIGN_VOICE_REFUSAL =
  "That recording belongs to someone else's upload. Record your own voice note and send that instead.";

/**
 * Collect the raw request body.
 *
 * Bounded: the socket is destroyed the moment the accumulated length passes the
 * ceiling, rather than buffering an unbounded upload into memory and checking
 * its size afterwards. `/api/media/upload` reads its body the same way but
 * without the bound; the bound is added here because this route's ceiling is
 * twelve times smaller and the check costs one comparison per chunk.
 */
function collectBody(limitBytes: number) {
  return (req: any, res: any, next: any) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let done = false;
    req.on("data", (c: Buffer) => {
      if (done) return;
      total += c.length;
      if (total > limitBytes) {
        done = true;
        sendError(res, "invalid_payload", `Voice note too large. Maximum ${Math.round(limitBytes / 1024 / 1024)} MB.`);
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      if (done) return;
      done = true;
      req.rawBody = Buffer.concat(chunks);
      next();
    });
    req.on("error", (err: unknown) => {
      if (done) return;
      done = true;
      next(err);
    });
  };
}

// ── POST /api/telegraph/voice/upload ─────────────────────────────────────────

router.post(
  "/telegraph/voice/upload",
  collectBody(VOICE_SIZE_LIMIT),
  asyncHandler(async (req: any, res: any) => {
    const auth = await requireUser(req, res);
    if (!auth) return;
    const { user } = auth;

    const sc = getServiceClient();
    if (!sc) {
      sendError(res, "server_not_configured", "Storage not configured");
      return;
    }

    // Kill switch + the SHARED per-user upload budget.
    const guard = await guardUploadRequest(sc, user.id);
    if (!guard.ok) {
      if (guard.failure.code === "rate_limited") {
        res.setHeader("Retry-After", Math.ceil(guard.failure.retryAfterMs / 1000).toString());
      }
      sendError(res, guard.failure.code, guard.failure.message);
      return;
    }

    const declaredMime = String(req.headers["content-type"] ?? "").split(";")[0].trim();
    const raw: Buffer = req.rawBody;
    const declared = validateDeclaredVoiceUpload({
      mimeType: declaredMime,
      fileSizeBytes: raw?.length ?? 0,
    });
    if (!declared.ok) {
      sendError(res, declared.failure.code, declared.failure.message);
      return;
    }

    // The bytes decide, and the location scrub runs. A declaration that the
    // bytes contradict is refused here, not stored and corrected later.
    const verified = verifyUploadedVoiceBytes(raw);
    if (!verified.ok) {
      sendError(res, verified.failure.code, verified.failure.message);
      return;
    }
    const { sniffed, buffer, stripped } = verified.value;
    if (stripped.length > 0) {
      log.info({ stripped, userId: user.id }, "voice note location metadata stripped");
    }

    const path = `${user.id}/voice/${Date.now()}.${sniffed.ext}`;
    const { error: upErr } = await sc.storage
      .from(STORAGE_BUCKET)
      .upload(path, buffer, { contentType: sniffed.mime, upsert: false });
    if (upErr) {
      log.error({ err: upErr, path }, "voice upload to storage failed");
      sendError(res, "db_error", `Upload failed: ${upErr.message}`);
      return;
    }

    res.status(201).json({
      url: `${STORAGE_BUCKET}/${path}`,
      path,
      mimeType: sniffed.mime,
      sizeBytes: buffer.length,
      maxDurationSeconds: VOICE_MAX_DURATION_SECONDS,
      maxWaveformPeaks: WAVEFORM_MAX_PEAKS,
    });
  }),
);

// ── POST /api/threads/:threadId/voice ────────────────────────────────────────

router.post(
  "/threads/:threadId/voice",
  asyncHandler(async (req: any, res: any) => {
    const auth = await requireUser(req, res);
    if (!auth) return;
    const { client, user } = auth;
    const { threadId } = req.params;

    if (!UUID.test(threadId)) {
      sendError(res, "invalid_payload", "Invalid threadId");
      return;
    }

    const validated = validateVoicePayload(req.body?.payload ?? req.body);
    if (!validated.ok) {
      sendError(res, "invalid_payload", validated.error);
      return;
    }
    const payload = validated.payload;

    // The URL must be OUR storage. Without this the route would accept any
    // string and a voice bubble would fetch an attacker-chosen origin every
    // time a member opened the thread — the hotlink/tracker/SSRF hole
    // `lib/mediaUrl.ts` exists to close, re-opened on a new surface.
    if (!appStorageUrlInfo(payload.url)) {
      sendError(
        res,
        "invalid_payload",
        "url must be an uploaded app storage path (use POST /api/telegraph/voice/upload first)",
      );
      return;
    }

    // ...AND it must be the CALLER'S object. `appStorageUrlInfo` answers
    // "whose HOST", never "whose OBJECT" (`lib/intelEvidenceCapture.ts` says so
    // in those words), and `post-media` is a PRIVATE bucket. Without this,
    // `lib/mediaAccess.ts` branch 3c — which authorises message media on
    // "some message references this object AND the viewer is in that message's
    // thread", never on who owned it — would serve any object whose key a
    // member could name to every member of a thread they control. Branches 3b,
    // 3d and 3e were each hardened against exactly that composition; 3c was
    // not, so the refusal has to happen here, at the write.
    //
    // Same classifier, same three verdicts, as `POST /memories/:id/items`:
    // only `foreign_storage` is refused. An `external` URL is out of scope for
    // this route (the `appStorageUrlInfo` check above already refused it), and
    // `unattributable_storage` — one of our objects whose path names no owner —
    // is accepted and logged, because refusing on an inability to attribute
    // turns a naming convention into an outage.
    const origin = classifyMemoryMediaUrl(payload.url, user.id);
    if (origin.verdict === "foreign_storage") {
      log.error(
        { threadId, actorUserId: user.id, bucket: origin.bucket, path: origin.path },
        "voice: refused a note whose storage path belongs to another user",
      );
      // Names no other user's id: a refusal that echoed it would turn this
      // guard into the ownership oracle it exists to remove.
      sendError(res, "invalid_payload", FOREIGN_VOICE_REFUSAL);
      return;
    }
    if (origin.verdict === "unattributable_storage") {
      log.warn(
        { threadId, actorUserId: user.id, bucket: origin.bucket, path: origin.path },
        "voice: note points at one of our objects whose owner cannot be derived from its path — accepted, unattributed",
      );
    }

    // The declared container must be one this server would have stored. A row
    // claiming `audio/ogg` could only have come from bytes this server never
    // accepted, so believing the field would make the row describe an object
    // that does not exist in the form it claims.
    if (!ALLOWED_VOICE_MIME[payload.mimeType]) {
      sendError(
        res,
        "invalid_payload",
        `Unsupported voice type: ${payload.mimeType}. Supported: ${Object.keys(ALLOWED_VOICE_MIME).join(", ")}`,
      );
      return;
    }

    const guard = await guardTelegraphThreadWrite(client, threadId, user.id);
    if (!guard.ok) {
      sendError(res, guard.code, guard.message);
      return;
    }

    const replyToIdRaw = req.body?.replyToId;
    const replyToId = typeof replyToIdRaw === "string" && UUID.test(replyToIdRaw) ? replyToIdRaw : null;
    const clientId = typeof req.body?.clientId === "string" ? req.body.clientId.slice(0, 64) : null;

    const now = new Date().toISOString();
    const { data: msg, error: msgErr } = await client
      .from("messages")
      .insert(voiceMessageRow({ threadId, senderId: user.id, payload, createdAt: now, replyToId }))
      .select(
        "id, thread_id, sender_id, body, created_at, msg_type, subtype, reply_to_id, media_url, media_type, media_duration_seconds",
      )
      .single();

    if (msgErr || !msg) {
      // ONE failure mode here is not a bug and must not read as one: migration
      // 2989 widens messages.media_type to admit 'audio', and until it is
      // applied the database's own CHECK refuses this row. Reporting that as a
      // generic `db_error` would send an operator hunting through the route for
      // a fault that is a pending migration.
      if (isAudioMediaTypeRejection(msgErr)) {
        log.error({ err: msgErr, threadId }, "voice insert refused: migration 2989 is not applied");
        sendError(res, "degraded_unavailable", AUDIO_MIGRATION_PENDING_MESSAGE);
        return;
      }
      log.error({ err: msgErr, threadId }, "voice message insert failed");
      sendError(res, "db_error", msgErr?.message ?? "Failed to send");
      return;
    }

    const { error: bumpErr } = await client
      .from("message_threads")
      .update({ last_message_at: now, updated_at: now })
      .eq("id", threadId);
    if (bumpErr) {
      log.warn({ err: bumpErr, threadId }, "thread bump after voice send failed (message was written)");
    }

    const m = msg as any;
    res.status(201).json({
      id: m.id,
      threadId: m.thread_id,
      senderId: m.sender_id,
      createdAt: m.created_at,
      msgType: m.msg_type,
      subtype: null,
      replyToId: m.reply_to_id ?? null,
      kind: "VOICE",
      payload,
      mediaUrl: m.media_url,
      mediaType: m.media_type,
      mediaDurationSeconds: m.media_duration_seconds,
      clientId,
    });

    void publishToThread(client, threadId, {
      type: "message.created",
      payload: {
        messageId: m.id,
        senderId: m.sender_id,
        msgType: m.msg_type,
        subtype: null,
        createdAt: m.created_at,
      },
    });
  }),
);

export default router;
