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
import { effectiveCapability, FORWARDING_FLAG } from "./forwarding.js";
import { negotiateRender, parseClientCapabilities, STRUCTURED_SCHEMAS_FLAG, type ClientCapabilities } from "./structuredSchemas.js";

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
    isFlagEnabled(sc, STRUCTURED_SCHEMAS_FLAG),
    isFlagEnabled(sc, FORWARDING_FLAG),
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
