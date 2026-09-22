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
import { guardTelegraphThreadWrite } from "../lib/telegraphThreadWrite.js";
import { emitLocationStarted, publishToThread } from "../lib/telegraphEvents.js";
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
  MAX_LOCATION_SHARE_HOURS,
  type DrawerTab,
} from "../services/telegraph/messageKinds.js";
import {
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
  replyToId: z.string().max(64).nullish(),
  clientId: z.string().max(64).nullish(),
});

type MemberGate =
  | { ok: true; visibleFrom: string | null }
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
  return { ok: true, visibleFrom: visibleFromOf(data as any, boundOn) };
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
): Promise<{ ok: true; rows: any[] } | { ok: false; message: string }> {
  let q = client
    .from("messages")
    .select(DRAWER_COLUMNS)
    .eq("thread_id", threadId)
    .is("deleted_at", null)
    .order("created_at", { ascending: false })
    .limit(DRAWER_SCAN_LIMIT);
  if (visibleFrom) q = q.gte("created_at", visibleFrom);

  const { data, error } = await q;
  if (error) return { ok: false, message: error.message ?? "messages read failed" };
  const rows = ((data as any[]) ?? []).filter((r) => withinWindow(r.created_at, visibleFrom));
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

    /**
     * §12 `location_shares` — an EXPIRY that is a real bound, checked here
     * because a schema can say "a string" and not "in the future, and not next
     * year".
     *
     * Two refusals and they are different mistakes. An expiry already in the
     * past is a share that was never live: the sweep's window would never
     * contain it, so `location.started` would be emitted for a capability that
     * ends before anybody sees it and `location.expired` would never follow —
     * a live chip nothing ever takes down. An expiry beyond the ceiling is an
     * unbounded share wearing a timestamp, which is the thing §15.1 exists to
     * refuse.
     */
    let locationShare: { expiresAt: string; precision: string; purpose: string | null } | null = null;
    if (validated.envelope.kind === "LOCATION") {
      const lp = (validated.envelope as any).payload as {
        expiresAt?: string | null;
        precision?: string;
        purpose?: string | null;
      };
      if (typeof lp.expiresAt === "string" && lp.expiresAt.length > 0) {
        const endsMs = Date.parse(lp.expiresAt);
        const nowMs = Date.now();
        if (!Number.isFinite(endsMs)) {
          sendError(res, "invalid_payload", "expiresAt must be an ISO timestamp");
          return;
        }
        if (endsMs <= nowMs) {
          sendError(res, "invalid_payload",
            "expiresAt is already past. A share that has expired before it is posted is never live, " +
            "so nothing would ever take it down.");
          return;
        }
        if (endsMs > nowMs + MAX_LOCATION_SHARE_HOURS * 3600_000) {
          sendError(res, "invalid_payload",
            `A scoped location share may run for at most ${MAX_LOCATION_SHARE_HOURS} hours (§15.1). ` +
            "A longer one is an unbounded capability with a timestamp on it.");
          return;
        }
        locationShare = {
          expiresAt: lp.expiresAt,
          precision: String(lp.precision ?? "area"),
          purpose: lp.purpose ?? null,
        };
      }
    }

    const guard = await guardTelegraphThreadWrite(client, threadId, user.id);
    if (!guard.ok) {
      sendError(res, guard.code, guard.message);
      return;
    }

    const now = new Date().toISOString();
    const { data: msg, error: msgErr } = await client
      .from("messages")
      .insert({
        thread_id: threadId,
        sender_id: user.id,
        body: JSON.stringify(validated.envelope),
        created_at: now,
        msg_type: validated.msgType,
        subtype: validated.subtype,
      })
      .select("id, thread_id, sender_id, body, created_at, msg_type, subtype")
      .single();

    if (msgErr || !msg) {
      log.error({ err: msgErr, threadId, kind: parsed.data.kind }, "typed message insert failed");
      sendError(res, "db_error", msgErr?.message ?? "Failed to send");
      return;
    }

    const { error: bumpErr } = await client
      .from("message_threads")
      .update({ last_message_at: now, updated_at: now })
      .eq("id", threadId);
    if (bumpErr) {
      log.warn({ err: bumpErr, threadId }, "thread bump after typed send failed (message was written)");
    }

    const m = msg as any;
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

    void publishToThread(client, threadId, {
      type: "message.created",
      payload: {
        messageId: m.id,
        senderId: m.sender_id,
        msgType: m.msg_type,
        subtype: m.subtype,
        createdAt: m.created_at,
      },
    });

    // §13.2 `location.started`. Only for a share with an expiry: a LOCATION
    // message with none is a pin — somebody sending an address — and it has no
    // lifecycle for this event to be about. The payload carries the precision
    // and the window and NEVER a coordinate; a member entitled to those already
    // has them in the message, behind that message's own read gate.
    if (locationShare) {
      void emitLocationStarted(client, threadId, {
        shareId: String(m.id),
        ownerUserId: String(m.sender_id),
        precision: locationShare.precision,
        purpose: locationShare.purpose,
        startedAt: String(m.created_at),
        expiresAt: locationShare.expiresAt,
      });
    }
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

    const read = await readIndexableRows(client, threadId, gate.visibleFrom);
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

    const read = await readIndexableRows(client, threadId, gate.visibleFrom);
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
