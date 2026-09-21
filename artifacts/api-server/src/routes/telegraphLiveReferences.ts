/**
 * Telegraph live references — Sensing §12: a conversation shares a CANONICAL
 * REFERENCE to a server-built live object (lib/liveReference), never a copy
 * of its prose, and a shared reference resolves against the CURRENT state
 * with "changed since sharing" on the answer.
 *
 * POST /api/telegraph/threads/:threadId/live-references
 *   Body { subjectId, kind, note? }. For an ACTIVE member of the thread, reads
 *   the subject's current claims through lib/liveClaimRead (the one gated
 *   path), the newest versions from the projection's own record to pin to,
 *   and — for a world_moment — the transition lib/wallMoments detects against
 *   the previous readings; builds the reference and writes it as a `card`
 *   message of subtype `live_reference` (service client: members cannot
 *   INSERT messages, see lib/liveReferenceMessages). Answers the message id
 *   and the reference. Nothing to point at is a named refusal, not a card.
 *
 * GET /api/telegraph/live-references/:messageId
 *   For an ACTIVE member of the card's thread: the stored reference, the
 *   subject's CURRENT claims (through the same gate), and the comparison —
 *   per claim unchanged / reaffirmed / changed / expired / withdrawn / added,
 *   and `changedSinceShare`, which is NULL, never false, when the current
 *   state could not be read.
 *
 * Gated by `telegraph_live_references_enabled` (migration 2802, seeded
 * FALSE), read fail-closed. Security: requireUser, and membership is checked
 * here by the predicate the database's own policies use. Nothing
 * person-shaped is on the wire: snapshot and version ids are opaque.
 */
import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../lib/asyncHandler.js";
import { requireUser, sendError } from "../lib/http.js";
import { getServiceClient } from "../lib/supabase.js";
import { isFlagEnabled } from "../lib/featureFlags.js";
import { liveLabelsServable, readLiveClaimEnvelopes } from "../lib/liveClaimRead.js";
import { truthOfEnvelopes } from "../lib/liveEnvelopeTruth.js";
import { detectTransitions, type WorldTransition } from "../lib/wallMoments.js";
import { readPreviousReadings } from "../lib/wallMomentRead.js";
import {
  LIVE_REFERENCE_CLAIM_TYPES,
  LIVE_REFERENCE_KINDS,
  LIVE_REFERENCE_NOTE_MAX,
  buildLiveReference,
  compareLiveReference,
  parseLiveReference,
  refusedComparison,
  type LiveReferenceComparison,
} from "../lib/liveReference.js";
import {
  insertLiveReferenceMessage,
  isActiveThreadMember,
  readLatestVersions,
  readLiveReferenceMessage,
} from "../lib/liveReferenceMessages.js";

const router = Router();

/** Literal name so check-flag-polarity resolves the reads. `*_enabled` ⇒ capability, fail-closed. */
export const TELEGRAPH_LIVE_REFERENCES_FLAG = "telegraph_live_references_enabled";

const uuid = z.string().uuid();
const shareSchema = z.object({
  subjectId: uuid,
  kind: z.enum(LIVE_REFERENCE_KINDS),
  note: z.string().max(LIVE_REFERENCE_NOTE_MAX).optional(),
});

interface PlaceRow {
  id: string;
  name?: string | null;
  status?: string | null;
  merged_into_place_id?: string | null;
}

/** The subject: an ACTIVE, unmerged place; null otherwise. A missing status is not "active". */
async function readReferenceablePlace(sc: any, placeId: string): Promise<PlaceRow | null> {
  const { data, error } = await sc
    .from("places")
    .select("id, name, status, merged_into_place_id")
    .eq("id", placeId)
    .maybeSingle();
  if (error || !data) return null;
  const p = data as PlaceRow;
  if (p.status !== "active" || p.merged_into_place_id != null) return null;
  return p;
}

/** The newest transition the subject evidences, or null. A failed history read is the caller's refusal. */
async function newestTransition(
  sc: any,
  subjectId: string,
  current: Parameters<typeof detectTransitions>[0],
): Promise<{ ok: true; transition: WorldTransition | null } | { ok: false; reason: "versions_unavailable" | "error" }> {
  const previous = await readPreviousReadings(sc, subjectId, LIVE_REFERENCE_CLAIM_TYPES.world_moment);
  if (!previous.ok) return { ok: false, reason: previous.reason === "no_client" ? "error" : previous.reason };
  const transitions = detectTransitions(current, previous.readings).sort((a, b) => Date.parse(b.occurredAt) - Date.parse(a.occurredAt));
  return { ok: true, transition: transitions[0] ?? null };
}

router.post(
  "/telegraph/threads/:threadId/live-references",
  asyncHandler(async (req, res) => {
    const auth = await requireUser(req, res);
    if (!auth) return;
    const sc = getServiceClient();
    if (!sc) {
      sendError(res, "server_not_configured", "Service client unavailable");
      return;
    }
    if (!(await isFlagEnabled(sc, "telegraph_live_references_enabled"))) {
      sendError(res, "feature_disabled", "Telegraph live references are not enabled");
      return;
    }
    const threadId = uuid.safeParse(req.params.threadId);
    if (!threadId.success) {
      sendError(res, "invalid_payload", "Invalid thread id");
      return;
    }
    const parsed = shareSchema.safeParse(req.body);
    if (!parsed.success) {
      sendError(res, "invalid_payload", parsed.error.issues[0]?.message ?? "Invalid payload");
      return;
    }
    const membership = await isActiveThreadMember(sc, threadId.data, auth.user.id);
    if (!membership.ok) {
      sendError(res, "db_error", "Could not read thread membership");
      return;
    }
    if (!membership.member) {
      sendError(res, "forbidden", "Not a member of this conversation");
      return;
    }
    const { subjectId, kind, note } = parsed.data;
    const place = await readReferenceablePlace(sc, subjectId);
    if (!place) {
      sendError(res, "not_found", "Place not found");
      return;
    }
    const now = new Date();
    const nowMs = now.getTime();
    if (!(await liveLabelsServable(sc))) {
      res.status(200).json({ ok: false, refusal: "live_intelligence_unavailable", generatedAt: now.toISOString() });
      return;
    }
    const claimTypes = LIVE_REFERENCE_CLAIM_TYPES[kind];
    const envelopes = await readLiveClaimEnvelopes(sc, subjectId, { claimTypes, now });

    let transition: WorldTransition | null = null;
    if (kind === "world_moment") {
      const t = await newestTransition(sc, subjectId, envelopes);
      if (!t.ok) {
        res.status(200).json({ ok: false, refusal: t.reason, generatedAt: now.toISOString() });
        return;
      }
      transition = t.transition;
    }
    // The version record is a pin, not a gate: an unreadable record leaves versionId null.
    const latest = await readLatestVersions(sc, subjectId, claimTypes);
    const built = buildLiveReference({
      kind,
      subject: { id: place.id, name: typeof place.name === "string" ? place.name : null },
      envelopes,
      versions: latest.ok ? latest.versions : null,
      transition,
      note: note ?? null,
      nowMs,
    });
    if (!built.ok) {
      res.status(200).json({ ok: false, refusal: built.refusal, generatedAt: now.toISOString() });
      return;
    }
    const written = await insertLiveReferenceMessage(sc, { threadId: threadId.data, senderId: auth.user.id, reference: built.reference });
    if (!written.ok) {
      sendError(res, "db_error", "Could not write the reference");
      return;
    }
    res.status(201).json({
      ok: true,
      messageId: written.messageId,
      createdAt: written.createdAt,
      reference: built.reference,
      versionsPinned: latest.ok,
      generatedAt: now.toISOString(),
    });
  }),
);

router.get(
  "/telegraph/live-references/:messageId",
  asyncHandler(async (req, res) => {
    const auth = await requireUser(req, res);
    if (!auth) return;
    const sc = getServiceClient();
    if (!sc) {
      sendError(res, "server_not_configured", "Service client unavailable");
      return;
    }
    if (!(await isFlagEnabled(sc, "telegraph_live_references_enabled"))) {
      sendError(res, "feature_disabled", "Telegraph live references are not enabled");
      return;
    }
    const messageId = uuid.safeParse(req.params.messageId);
    if (!messageId.success) {
      sendError(res, "invalid_payload", "Invalid message id");
      return;
    }
    const read = await readLiveReferenceMessage(sc, messageId.data);
    if (!read.ok) {
      if (read.reason === "not_found") sendError(res, "not_found", "Reference not found");
      else sendError(res, "db_error", "Could not read the reference");
      return;
    }
    const membership = await isActiveThreadMember(sc, read.message.threadId, auth.user.id);
    if (!membership.ok) {
      sendError(res, "db_error", "Could not read thread membership");
      return;
    }
    if (!membership.member) {
      // The same answer as an absent card: membership is not disclosed.
      sendError(res, "not_found", "Reference not found");
      return;
    }
    const now = new Date();
    const nowMs = now.getTime();
    const reference = parseLiveReference(read.message.body);
    if (!reference) {
      res.status(200).json({ ok: false, refusal: "malformed_reference", messageId: read.message.id, generatedAt: now.toISOString() });
      return;
    }
    let comparison: LiveReferenceComparison;
    let current: { claims: unknown[]; truth: unknown } | null = null;
    if (!(await liveLabelsServable(sc))) {
      comparison = refusedComparison(reference, "live_intelligence_unavailable", nowMs);
    } else {
      const envelopes = await readLiveClaimEnvelopes(sc, reference.subject.id, { claimTypes: LIVE_REFERENCE_CLAIM_TYPES[reference.kind], now });
      comparison = compareLiveReference(reference, envelopes, nowMs);
      current = { claims: envelopes, truth: truthOfEnvelopes(envelopes, nowMs) };
    }
    res.status(200).json({
      ok: true,
      messageId: read.message.id,
      threadId: read.message.threadId,
      sharedBy: read.message.senderId,
      reference,
      current,
      comparison,
      generatedAt: now.toISOString(),
    });
  }),
);

export default router;
