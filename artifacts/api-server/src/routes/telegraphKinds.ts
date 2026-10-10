/**
 * Telegraph §6 — typed message kinds, the content drawer, and object-aware
 * search.
 *
 *   POST /api/threads/:threadId/typed-messages
 *        §6.2's kinds that this tree can actually carry: MEDIA_ALBUM, GIF,
 *        LOCATION, ACTION, ANNOUNCEMENT, SAFETY, MEMORY_NOTE. A kind it
 *        cannot carry is refused BY NAME with the reason (see
 *        `services/telegraph/messageKinds.ts#UNSENDABLE_KINDS`).
 *
 *   GET  /api/threads/:threadId/drawer?tab=MEDIA|PLACES|PORTAVA|VOICE|GIFS|LINKS|FILES
 *        §6.4's content drawer — "a structured index over exchanged content,
 *        not a second storage copy". It writes nothing and stores nothing; it
 *        classifies rows the thread already has.
 *
 *   GET  /api/threads/:threadId/search?q=…&tab=…
 *        §6.4's object-aware search — "must respect current authorization and
 *        unsent/deleted state".
 *
 * ── AUTHORIZATION, AND THE THREE THINGS IT MEANS HERE ───────────────────────
 * 1. Active membership on every call. A failed membership read is a 500, not
 *    an empty drawer: an empty index and "you are not allowed" must not wear
 *    the same clothes.
 * 2. §14.3's history window. The drawer and the search page over the SAME rows
 *    `GET /threads/:id/messages` pages over, so a member added yesterday
 *    cannot reach last month's photos through the drawer — the bound is
 *    applied through `services/groupChatHistoryBound.ts`, the one module that
 *    owns that rule, rather than re-implemented here.
 * 3. §7.4's tombstones. A deleted (or unsent, on a database that has the
 *    column) row is excluded from BOTH surfaces, which is exactly what
 *    "remove from normal retrieval, search and projections" asks for.
 */
import { Router } from "express";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { requireUser, sendError } from "../lib/http.js";
import { asyncHandler } from "../lib/asyncHandler.js";
import { logger as rootLogger } from "../lib/logger.js";
import { guardTelegraphThreadWrite, sendThreadWriteRefusal } from "../lib/telegraphThreadWrite.js"; import { textOfPayload } from "../domain/telegraph/policies/groupControlsPolicy.js"; import { sendBucketForKind } from "../domain/telegraph/policies/messageDoorPolicy.js";
import { checkLocationShareWindow, writeThreadEnvelope } from "../services/telegraph/threadEnvelopeWrites.js";
import {
  DRAWER_TABS,
  drawerTabFor,
  extractLinks,
  isDrawerTab,
  matchesQuery,
  searchableTextOf,
  SENDABLE_ENVELOPE_KINDS,
  UNSENDABLE_KINDS,
  validateKindMessage,
  type DrawerTab,
} from "../services/telegraph/messageKinds.js";
import {
  applyHistoryWindow,
  historyBoundEnabled,
  membershipSelect,
  visibleFromOf,
  withinWindow,
} from "../services/groupChatHistoryBound.js";

const log = rootLogger.child({ route: "telegraphKinds" });
const router = Router();

const UUID = /^[0-9a-f-]{36}$/i;

/** How many rows the drawer and search scan and return. */
export const DRAWER_PAGE_LIMIT = 100;
export const DRAWER_SCAN_LIMIT = 500;

const TypedMessageSchema = z.object({
  kind: z.string().min(1).max(40),
  payload: z.unknown(),
  clientId: z.string().max(64).nullish(),
});

type MemberGate =
  // `viewerId` rides with `visibleFrom` — Q6's exception is (bound, viewer).
  | { ok: true; visibleFrom: string | null; viewerId: string }
  | { ok: false; code: "forbidden" | "db_error"; message: string };

/**
 * Active membership plus this member's §14.3 window, in one read whose error is
 * observed. Returning the window here is what keeps the drawer and the thread
 * read agreeing about what this member may see.
 */
async function memberWindow(
  client: SupabaseClient,
  threadId: string,
  userId: string,
): Promise<MemberGate> {
  const boundOn = await historyBoundEnabled(client);
  const { data, error } = await client
    .from("message_thread_members")
    .select(membershipSelect("user_id, left_at", boundOn))
    .eq("thread_id", threadId)
    .eq("user_id", userId)
    .maybeSingle();
  if (error) return { ok: false, code: "db_error", message: error.message ?? "membership read failed" };
  if (!data || (data as any).left_at !== null) {
    return { ok: false, code: "forbidden", message: "Not an active member of this thread" };
  }
  return { ok: true, visibleFrom: visibleFromOf(data as any, boundOn), viewerId: userId };
}

const DRAWER_COLUMNS =
  "id, thread_id, sender_id, body, created_at, deleted_at, msg_type, subtype, media_url, media_type, media_thumbnail_url, media_duration_seconds";

interface DrawerRow {
  id: string;
  senderId: string;
  createdAt: string;
  tab: DrawerTab;
  msgType: string;
  subtype: string | null;
  /** The one or more assets/links this row contributes to the index. */
  previewUrl: string | null;
  title: string | null;
  links: string[];
}

function toDrawerRow(row: any, tab: DrawerTab): DrawerRow {
  return {
    id: row.id as string,
    senderId: row.sender_id as string,
    createdAt: row.created_at as string,
    tab,
    msgType: (row.msg_type as string) ?? "text",
    subtype: (row.subtype as string) ?? null,
    previewUrl: (row.media_thumbnail_url as string) ?? (row.media_url as string) ?? null,
    title: searchableTextOf(row)?.slice(0, 120) ?? null,
    links: tab === "LINKS" ? extractLinks(row.body as string) : [],
  };
}

/**
 * The shared read behind both surfaces: the thread's rows, membership-gated,
 * window-bounded, tombstone-excluded. Returns a failure rather than an empty
 * list when the read fails.
 */
async function readIndexableRows(
  client: SupabaseClient,
  threadId: string,
  visibleFrom: string | null,
  viewerId: string,
): Promise<{ ok: true; rows: any[] } | { ok: false; message: string }> {
  let q = client
    .from("messages")
    .select(DRAWER_COLUMNS)
    .eq("thread_id", threadId)
    .is("deleted_at", null)
    .order("created_at", { ascending: false })
    .limit(DRAWER_SCAN_LIMIT);
  // Q6 in the QUERY: `DRAWER_SCAN_LIMIT` caps this read, so a plain `.gte`
  // discards the caller's own earlier drawer objects in PostgREST before any
  // filter could admit them. `thread_id` and `deleted_at IS NULL` stay AND-ed
  // outside the relaxed clause, and `memberWindow` already proved ACTIVE
  // membership.
  q = applyHistoryWindow(q, visibleFrom, viewerId);

  const { data, error } = await q;
  if (error) return { ok: false, message: error.message ?? "messages read failed" };
  const rows = ((data as any[]) ?? []).filter((r) =>
    withinWindow(r.created_at, visibleFrom, { senderId: r.sender_id, viewerId }));
  return { ok: true, rows };
}

// ── POST /api/threads/:threadId/typed-messages ───────────────────────────────

router.post(
  "/threads/:threadId/typed-messages",
  asyncHandler(async (req: any, res: any) => {
    const auth = await requireUser(req, res);
    if (!auth) return;
    const { client, user } = auth;
    const { threadId } = req.params;

    if (!UUID.test(threadId)) {
      sendError(res, "invalid_payload", "Invalid threadId");
      return;
    }
    /**
     * `replyToId` is REFUSED BY NAME, not dropped. Until this check existed the
     * field sat in the schema above, parsed cleanly, and was then written
     * nowhere: the insert (`writeThreadEnvelope`) carries no `reply_to_id` and the 201 echoes
     * none. That is precisely the failure the thread read's T344 note
     * (`routes/messaging.ts:2443-2453`) exists to prevent — "a reply whose
     * quote vanished and a message that was never a reply look identical on the
     * wire" — except here the write side manufactured it, and told the sender
     * 201 while doing so.
     *
     * Refusing rather than persisting is deliberate. A typed message's `body`
     * is `JSON.stringify(input.envelope)` in `writeThreadEnvelope`, and the thread read's
     * quote builder copies a replied-to body VERBATIM
     * (`routes/messaging.ts:2504`, `body: qr.body ?? ''`). So persisting
     * `reply_to_id` here with no other change would make a reply TO a typed
     * message quote a raw JSON envelope string in the thread. Carrying replies
     * on typed kinds therefore also obliges an envelope-aware quote renderer,
     * which is a larger piece of work and a separate decision. Until that
     * exists the honest answer is a refusal the caller can act on.
     *
     * An explicit `null` is the absence of a reply, not a request for one, so
     * it is not a mistake and is not refused.
     */
    const replyToIdGiven = (req.body as { replyToId?: unknown } | null | undefined)?.replyToId;
    if (replyToIdGiven !== undefined && replyToIdGiven !== null) {
      sendError(
        res,
        "invalid_payload",
        "replyToId is not supported on typed messages. A typed message's body is a JSON " +
          "envelope and the thread read quotes a replied-to body verbatim, so a reply to one " +
          "would render as raw JSON. Send the reply as an ordinary message, or post this kind " +
          "without replyToId.",
      );
      return;
    }

    const parsed = TypedMessageSchema.safeParse(req.body);
    if (!parsed.success) {
      sendError(res, "invalid_payload", parsed.error.issues[0]?.message ?? "Invalid body");
      return;
    }

    const validated = validateKindMessage(parsed.data.kind, parsed.data.payload);
    if (!validated.ok) {
      sendError(res, "invalid_payload", validated.error);
      return;
    }

    // §12 `location_shares` — the expiry is a real bound (in the past, or past
    // §15.1's ceiling, is refused). The rule lives with the ONE writer both this
    // route and POST /telegraph/commands SHARE_LOCATION use, and runs BEFORE the
    // guard so an impossible expiry does not spend the sender's burst allowance.
    //
    // ONE clock read for this request. `splitClockGuard` refuses a handler that
    // calls both `Date.now()` and a no-arg `new Date()`: the expiry this route
    // VALIDATED and the `created_at` it STORED must be the same instant.
    const nowMs = Date.now();
    const window = checkLocationShareWindow(
      validated.envelope.kind,
      (validated.envelope as { payload?: { expiresAt?: string | null; precision?: string; purpose?: string | null } }).payload,
      nowMs,
    );
    if (!window.ok) {
      sendError(res, "invalid_payload", window.message);
      return;
    }

    const guard = await guardTelegraphThreadWrite(client, threadId, user.id, { sendBucket: sendBucketForKind(validated.envelope.kind), groupSend: { media: validated.envelope.kind === "MEDIA_ALBUM" || validated.envelope.kind === "GIF", text: textOfPayload(validated.envelope.payload) } });
    if (!guard.ok) {
      sendThreadWriteRefusal(res, guard);
      return;
    }

    // §13.1 — the ONE writer this route and the command bus share.
    const written = await writeThreadEnvelope(client, {
      threadId,
      senderId: user.id,
      envelope: validated.envelope,
      msgType: validated.msgType,
      subtype: validated.subtype,
      nowMs,
      locationShare: window.share,
    }, log);
    if (!written.ok) {
      log.error({ threadId, kind: parsed.data.kind, message: written.message }, "typed message insert failed");
      sendError(res, "db_error", written.message);
      return;
    }

    const m = written.row;
    res.status(201).json({
      id: m.id,
      threadId: m.thread_id,
      senderId: m.sender_id,
      createdAt: m.created_at,
      msgType: m.msg_type,
      subtype: m.subtype,
      kind: validated.envelope.kind,
      payload: (validated.envelope as any).payload,
      clientId: parsed.data.clientId ?? null,
    });
  }),
);

/** What a client may send, and what it may not, with the reason for each. */
router.get(
  "/telegraph/message-kinds",
  asyncHandler(async (req: any, res: any) => {
    const auth = await requireUser(req, res);
    if (!auth) return;
    res.status(200).json({
      sendable: SENDABLE_ENVELOPE_KINDS,
      unsendable: UNSENDABLE_KINDS,
      drawerTabs: DRAWER_TABS,
    });
  }),
);

// ── GET /api/threads/:threadId/drawer ────────────────────────────────────────

router.get(
  "/threads/:threadId/drawer",
  asyncHandler(async (req: any, res: any) => {
    const auth = await requireUser(req, res);
    if (!auth) return;
    const { client, user } = auth;
    const { threadId } = req.params;

    if (!UUID.test(threadId)) {
      sendError(res, "invalid_payload", "Invalid threadId");
      return;
    }
    const tabRaw = typeof req.query.tab === "string" ? req.query.tab.toUpperCase() : null;
    if (tabRaw !== null && !isDrawerTab(tabRaw)) {
      sendError(res, "invalid_payload", `tab must be one of: ${DRAWER_TABS.join(", ")}`);
      return;
    }

    const gate = await memberWindow(client, threadId, user.id);
    if (!gate.ok) {
      sendError(res, gate.code, gate.message);
      return;
    }

    const read = await readIndexableRows(client, threadId, gate.visibleFrom, gate.viewerId);
    if (!read.ok) {
      log.error({ threadId, message: read.message }, "drawer read failed");
      sendError(res, "db_error", "Could not read this conversation's content");
      return;
    }

    const counts: Record<DrawerTab, number> = {
      MEDIA: 0, PLACES: 0, PORTAVA: 0, VOICE: 0, GIFS: 0, LINKS: 0, FILES: 0,
    };
    const items: DrawerRow[] = [];
    for (const row of read.rows) {
      const tab = drawerTabFor(row);
      if (!tab) continue;
      counts[tab] += 1;
      if (tabRaw === null || tab === tabRaw) {
        if (items.length < DRAWER_PAGE_LIMIT) items.push(toDrawerRow(row, tab));
      }
    }

    res.status(200).json({
      threadId,
      tab: tabRaw,
      tabs: DRAWER_TABS,
      counts,
      items,
      /**
       * §6.4: "a structured index over exchanged content, not a second storage
       * copy". Stated in the response so the property is visible to a reader
       * of the API, not only to a reader of this file: every id above is a
       * `messages.id` that already existed.
       */
      indexOnly: true,
      scanned: read.rows.length,
      truncated: read.rows.length >= DRAWER_SCAN_LIMIT,
    });
  }),
);

// ── GET /api/threads/:threadId/search ────────────────────────────────────────

router.get(
  "/threads/:threadId/search",
  asyncHandler(async (req: any, res: any) => {
    const auth = await requireUser(req, res);
    if (!auth) return;
    const { client, user } = auth;
    const { threadId } = req.params;

    if (!UUID.test(threadId)) {
      sendError(res, "invalid_payload", "Invalid threadId");
      return;
    }
    const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
    if (q.length < 2) {
      sendError(res, "invalid_payload", "q must be at least 2 characters");
      return;
    }
    const tabRaw = typeof req.query.tab === "string" ? req.query.tab.toUpperCase() : null;
    if (tabRaw !== null && !isDrawerTab(tabRaw)) {
      sendError(res, "invalid_payload", `tab must be one of: ${DRAWER_TABS.join(", ")}`);
      return;
    }

    const gate = await memberWindow(client, threadId, user.id);
    if (!gate.ok) {
      sendError(res, gate.code, gate.message);
      return;
    }

    const read = await readIndexableRows(client, threadId, gate.visibleFrom, gate.viewerId);
    if (!read.ok) {
      log.error({ threadId, message: read.message }, "search read failed");
      sendError(res, "db_error", "Could not search this conversation");
      return;
    }

    const results = [];
    for (const row of read.rows) {
      const text = searchableTextOf(row);
      if (!matchesQuery(text, q)) continue;
      const tab = drawerTabFor(row);
      if (tabRaw !== null && tab !== tabRaw) continue;
      results.push({
        id: row.id as string,
        senderId: row.sender_id as string,
        createdAt: row.created_at as string,
        msgType: (row.msg_type as string) ?? "text",
        subtype: (row.subtype as string) ?? null,
        tab,
        snippet: (text ?? "").slice(0, 160),
      });
      if (results.length >= DRAWER_PAGE_LIMIT) break;
    }

    res.status(200).json({ threadId, query: q, tab: tabRaw, results, scanned: read.rows.length });
  }),
);

export default router;
