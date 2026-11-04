/**
 * The thread read's two platform decorations (census-telegraph T429/T431 and
 * T406/T407), applied by `GET /threads/:threadId/messages` to the page it has
 * already authorized, windowed and built. Each one is behind its own flag,
 * seeded FALSE (3665); with both OFF this function reads two flags and changes
 * nothing.
 *
 *   1. NEGOTIATION (telegraph_structured_schemas_enabled). Every structured row
 *      is classified against the schema registry. A row the client did not
 *      declare it renders — or whose schema this server does not know, or whose
 *      payload does not validate — is served as a plain TEXT row carrying a
 *      fixed sentence, so the oldest client in the field renders a bubble and
 *      the newest can read `structured.fallback`. The payload, the media and
 *      the spans are removed, never just hidden behind a flag the client may
 *      not read. A reply QUOTING such a row is degraded the same way, because
 *      the quote is the raw body.
 *
 *   2. PROVENANCE (telegraph_forwarding_enabled). A derivative carries
 *      `forwarded: { provenance }` — the one word §30A.9 lets the new audience
 *      see — and every row carries the capability in force, so a client can
 *      tell before it tries whether Forward is offered. Nothing about the
 *      source (thread, author, time) is read into this response: the
 *      provenance read selects `target_message_id, provenance, capability` and
 *      no other column of `message_forwards`.
 */
import { isFlagEnabled } from "../../lib/featureFlags.js";
import { effectiveCapability } from "./forwarding.js";
import { negotiateRender, parseClientCapabilities, type ClientCapabilities } from "./structuredSchemas.js";

export interface RawThreadRow {
  id: string;
  msg_type?: string | null;
  subtype?: string | null;
  body?: string | null;
  deleted_at?: string | null;
}

type Log = { warn?: (...a: any[]) => void } | undefined;

/** Replace a row's content with the fallback sentence. Mutates the outgoing message object. */
export function applyFallback(
  m: Record<string, any>,
  neg: { schemaId: string; reason: string; label: string },
): void {
  const originalMsgType = m.msgType ?? null;
  m.body = neg.label;
  m.displayBody = neg.label;
  m.originalBody = null;
  m.translated = false;
  m.translationStatus = null;
  m.translationLabel = null;
  m.canShowOriginal = false;
  m.showOriginalAlongside = false;
  m.msgType = "text";
  m.subtype = null;
  m.mediaUrl = null;
  m.mediaType = null;
  m.mediaThumbnailUrl = null;
  m.mediaDurationSeconds = null;
  if ("tags" in m) m.tags = [];
  if ("hashtagUsages" in m) m.hashtagUsages = [];
  delete m.safetySignals;
  m.structured = { schema: neg.schemaId, fallback: true, reason: neg.reason, originalMsgType };
}

/** A quoted body is a raw body: if it is a structured envelope the client cannot render, quote the sentence instead. */
export function negotiateQuotedBody(body: unknown, caps: ClientCapabilities): string | null {
  if (typeof body !== "string" || !body.startsWith("{")) return null;
  let kind: unknown;
  try {
    kind = JSON.parse(body)?.kind;
  } catch {
    return null;
  }
  if (typeof kind !== "string") return null;
  const neg = negotiateRender({ msg_type: kind.toLowerCase(), body }, caps);
  return neg.fallback ? neg.label : null;
}

export async function decoratePlatformReads(
  sc: any,
  rows: readonly RawThreadRow[],
  messages: Array<Record<string, any>>,
  headers: Record<string, unknown> | undefined,
  log?: Log,
): Promise<void> {
  const [schemasOn, forwardingOn] = await Promise.all([
    isFlagEnabled(sc, "telegraph_structured_schemas_enabled"),
    isFlagEnabled(sc, "telegraph_forwarding_enabled"),
  ]);

  if (schemasOn) {
    const caps = parseClientCapabilities(headers);
    const byId = new Map(messages.map((m) => [m.id as string, m]));
    for (const row of rows) {
      const m = byId.get(row.id);
      if (!m) continue;
      const neg = negotiateRender(row, caps);
      if (neg.fallback) applyFallback(m, neg);
      else if (neg.schemaId) m.structured = { schema: neg.schemaId, fallback: false };
    }
    for (const m of messages) {
      if (typeof m.replyToBody === "string") {
        const quoted = negotiateQuotedBody(m.replyToBody, caps);
        if (quoted !== null) m.replyToBody = quoted;
      }
    }
  }

  if (forwardingOn) {
    const ids = rows.filter((r) => !r.deleted_at).map((r) => r.id);
    if (ids.length === 0) return;
    const [fwd, caps] = await Promise.all([
      sc.from("message_forwards").select("target_message_id, provenance, capability").in("target_message_id", ids),
      sc.from("message_content_capabilities").select("message_id, capability").in("message_id", ids),
    ]);
    if (fwd.error || caps.error) {
      // Never "not forwarded" by default: a derivative read as an original would present the
      // forwarder as the author of someone else's words.
      log?.warn?.({ err: fwd.error ?? caps.error }, "thread read: forwarding provenance unreadable");
      for (const m of messages) if (ids.includes(m.id)) m.forwardContext = "unavailable";
      return;
    }
    const prov = new Map<string, { provenance: string; capability: string }>();
    for (const r of (fwd.data ?? []) as any[]) prov.set(String(r.target_message_id), { provenance: r.provenance, capability: r.capability });
    const explicit = new Map<string, string>();
    for (const r of (caps.data ?? []) as any[]) explicit.set(String(r.message_id), String(r.capability));
    for (const m of messages) {
      if (!ids.includes(m.id)) continue;
      const p = prov.get(m.id);
      if (p) m.forwarded = { provenance: p.provenance };
      m.contentCapability = effectiveCapability(explicit.get(m.id) ?? null, p?.capability ?? null);
    }
  }
}

// ── census-telegraph T370 (lane TELEGRAPH batch 3) — appended so every cited line keeps its number ──
/**
 * REACTIONS on the thread read. ADD_REACTION / REMOVE_REACTION write `message_reactions` (2811, applied
 * on production) through the command bus, and nothing READ them: no client could show a reaction.
 * This serves, per message, the aggregate a bubble draws — `reactions: [{ emoji, count, mine }]`,
 * most-used first — and never WHO reacted (a reaction roster is a per-recipient list §30A.12 bounds).
 *
 *   gate        2811's own: the command door refuses the reaction commands while
 *               telegraph_message_kernel_enabled is off, so the read serves nothing then either;
 *   blocks      a reaction by someone the viewer has blocked, or who blocked the viewer, is not counted —
 *               the same rule every other read applies to that person's content;
 *   unreadable  the reactions table OR the block list could not be read → `reactions: null` on each
 *               message: "could not be read", never [] ("nobody reacted"), and never a count that might
 *               include a blocked person;
 *   retracted   a deleted or unsent message carries no reactions.
 */
export const REACTION_DISPLAY_LIMIT = 8;

export async function decorateReactions(
  sc: any,
  rows: readonly RawThreadRow[],
  messages: Array<Record<string, any>>,
  viewerId: string,
  log?: Log,
): Promise<void> {
  if (!(await messageKernelEnabled(sc))) return;
  const ids = rows.filter((r) => !r.deleted_at && !(r as any).unsent_at).map((r) => r.id);
  if (ids.length === 0) return;
  const [reacted, blocks] = await Promise.all([
    sc.from("message_reactions").select("message_id, user_id, emoji, created_at").in("message_id", ids),
    readBlockExclusions(sc, viewerId),
  ]);
  if (reacted.error || !blocks.ok) {
    log?.warn?.({ err: reacted.error ?? (blocks as any).reason }, "thread read: reactions unreadable — served as unavailable, never as none");
    for (const m of messages) if (ids.includes(m.id)) m.reactions = null;
    return;
  }
  const per = new Map<string, Map<string, { count: number; mine: boolean; first: string }>>();
  for (const r of (reacted.data ?? []) as Array<{ message_id: string; user_id: string; emoji: string; created_at?: string }>) {
    if (r.user_id !== viewerId && blocks.ids.has(r.user_id)) continue;
    const byEmoji = per.get(r.message_id) ?? new Map();
    const e = byEmoji.get(r.emoji) ?? { count: 0, mine: false, first: r.created_at ?? "" };
    e.count += 1;
    if (r.user_id === viewerId) e.mine = true;
    if ((r.created_at ?? "") < e.first) e.first = r.created_at ?? "";
    byEmoji.set(r.emoji, e);
    per.set(r.message_id, byEmoji);
  }
  for (const m of messages) {
    if (!ids.includes(m.id)) continue;
    const byEmoji = per.get(m.id);
    m.reactions = byEmoji
      ? [...byEmoji.entries()]
          .sort((a, b) => b[1].count - a[1].count || a[1].first.localeCompare(b[1].first) || a[0].localeCompare(b[0]))
          .slice(0, REACTION_DISPLAY_LIMIT)
          .map(([emoji, e]) => ({ emoji, count: e.count, mine: e.mine }))
      : [];
  }
}

import { messageKernelEnabled } from "../telegraphMessageKernel.js";
import { readBlockExclusions } from "../../lib/exclusionSet.js";

// ── census-telegraph T431 (lane TELEGRAPH batch 4) — appended so every cited line keeps its number ──
/**
 * THE OTHER SERIALISERS. §86.2 recorded T431's sibling gap: negotiation covered `GET /threads/:id/messages`
 * and share projections ONLY, so "the inbox preview, the drawer, search and the single-message serialisers"
 * still served a stored structured body to a client that had declared it cannot render it — a LOCATION
 * envelope's coordinates in an inbox preview's first 80 characters, a saved location's raw body. Every
 * one of them now applies the thread page's decision, `negotiateRender`, to the row it serves, with the
 * same consequence: the content goes, the fixed sentence comes, and `structured` says which and why.
 *
 *   structuredNegotiation  the caller's declared capabilities while telegraph_structured_schemas_enabled
 *                          is ON; `null` while OFF, and every serialiser below is then byte-for-byte
 *                          unchanged. A client that declares nothing is the baseline (every registered
 *                          schema at v1), exactly as on the thread page.
 *   negotiateServed        one served object, given which of ITS fields carry the row's content: the body
 *                          fields take the sentence, the type fields become text, the media fields are
 *                          nulled and the list fields emptied — removed, never hidden behind a flag the
 *                          client may not read.
 *
 * Applied by: GET /me/threads (each `lastMessagePreview`), GET /threads/:id/drawer and
 * GET /threads/:id/search (routes/telegraphKinds.ts, each item and result), GET /telegraph/search and
 * GET /threads/:id/ask (each hit; a hit that falls back ranks as prose), GET /threads/:id/messages/:id/edits
 * (the current body and every version) and GET /me/saved-messages (each item). The group chat's own page
 * (routes/groupChat.ts GET /trips/:id/chat, /circles/:id/chat) is not reached: messaging.ts answers both
 * paths first (routes/index.ts mounts it ahead), with thread metadata and no messages.
 */
export async function structuredNegotiation(
  sc: any,
  headers: Record<string, unknown> | undefined,
): Promise<ClientCapabilities | null> {
  return (await isFlagEnabled(sc, "telegraph_structured_schemas_enabled")) ? parseClientCapabilities(headers) : null;
}

export interface ServedShape {
  /** Fields that carry the row's words: each becomes the fallback sentence. */
  body: readonly string[];
  /** The name of the field carrying the stored type, if the serialiser has one: it becomes "text". */
  typeField?: string;
  /** The name of the field carrying the stored subtype: it becomes null. */
  subtypeField?: string;
  /** Media or derived fields: nulled where present. */
  cleared?: readonly string[];
  /** List fields (links, tags…): emptied where present. */
  emptied?: readonly string[];
  /** Boolean claims about the content (translated, show-original): false where present. */
  falsified?: readonly string[];
}

/** Negotiate one served object in place. `caps === null` (flag OFF) changes nothing. */
export function negotiateServed(
  out: Record<string, any>,
  row: RawThreadRow,
  caps: ClientCapabilities | null,
  shape: ServedShape,
): void {
  if (!caps) return;
  const neg = negotiateRender(row, caps);
  if (!neg.fallback) {
    if (neg.schemaId) out.structured = { schema: neg.schemaId, fallback: false };
    return;
  }
  const originalMsgType = (shape.typeField ? out[shape.typeField] : undefined) ?? row.msg_type ?? null;
  for (const f of shape.body) out[f] = neg.label;
  if (shape.typeField) out[shape.typeField] = "text";
  if (shape.subtypeField) out[shape.subtypeField] = null;
  for (const f of shape.cleared ?? []) if (f in out) out[f] = null;
  for (const f of shape.emptied ?? []) if (f in out) out[f] = [];
  for (const f of shape.falsified ?? []) if (f in out) out[f] = false;
  out.structured = { schema: neg.schemaId, fallback: true, reason: neg.reason, originalMsgType };
}

/**
 * GET /threads/:id/messages/:id/edits: the current body and every earlier version. Negotiated on the row
 * as SERVED (after the location and card rules), so a version never carries what the current body may not.
 */
export function negotiateEditHistory<T extends { currentBody: string | null; versions: Array<Record<string, any>> }>(
  caps: ClientCapabilities | null,
  msg: RawThreadRow,
  payload: T,
): T & { structured?: Record<string, unknown> } {
  if (!caps) return payload;
  const neg = negotiateRender({ ...msg, body: payload.currentBody }, caps);
  if (!neg.fallback) return neg.schemaId ? { ...payload, structured: { schema: neg.schemaId, fallback: false } } : payload;
  return {
    ...payload,
    currentBody: neg.label,
    versions: payload.versions.map((v) => ({ ...v, previousBody: neg.label })),
    structured: { schema: neg.schemaId, fallback: true, reason: neg.reason, originalMsgType: msg.msg_type ?? null },
  };
}
