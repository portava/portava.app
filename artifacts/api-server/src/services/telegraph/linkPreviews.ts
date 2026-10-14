/**
 * Telegraph §30A.8 link previews — the rules both doors share (census-telegraph
 * T404 / T446; migration 3825; flag `telegraph_link_previews_enabled`, seeded
 * FALSE). The doors are `routes/telegraphLinkPreview.ts`.
 *
 * THE MODEL (b58/PLAN-telegraph-media.md TM-1; every default an OWNER QUESTION):
 *   - A preview is fetched ONCE, by the server, when the SENDER asks for it
 *     right after sending (Q-LP2). It is stored against the message.
 *   - Recipients only ever READ the stored row. Nothing a recipient does — open
 *     the thread, scroll, render — makes Portava or the recipient's device
 *     contact the linked site, so a sender cannot learn WHEN a recipient read
 *     the message by giving each recipient a unique URL (T446).
 *   - The URL is taken from the STORED body by the server. No endpoint accepts a
 *     URL from a client, so an end-to-end-encrypted thread — whose body the
 *     server never holds — can never have a preview, and a client cannot use
 *     Portava as a general fetcher (Q-LP3).
 *   - The preview lives exactly as long as the body it describes: an edit, an
 *     unsend or a delete-for-everyone removes it in the same transaction
 *     (3825's trigger), a hard delete or an account erasure cascades (Q-LP4).
 *     `source_digest` is checked on every read as well, so a row that somehow
 *     outlived its body is never served.
 */
import { createHash } from "node:crypto";
import {
  PREVIEW_DESCRIPTION_MAX,
  PREVIEW_HOST_MAX,
  PREVIEW_SITE_NAME_MAX,
  PREVIEW_TITLE_MAX,
  PREVIEW_URL_MAX,
} from "../../lib/outboundPreviewFetch.js";
import { configuredStorageOrigin } from "../../lib/mediaUrl.js";

/**
 * How long after the body was written (sent, or last edited) its sender may ask
 * for the preview. Past it the request is refused: a preview is a send-time
 * act, and a late fetch would be a fetch timed by something other than the
 * send — for example by noticing that the recipient has opened the thread.
 */
export const LINK_PREVIEW_SEND_WINDOW_MS = 15 * 60_000;

/** At most this many message ids per read. */
export const LINK_PREVIEW_BATCH_MAX = 50;

/** Per-person request budget on the POST (in addition to the in-flight gate). */
export const LINK_PREVIEW_RATE = { limit: 20, windowMs: 60_000 } as const;

/**
 * Portava's own web hosts. A link to one is an in-app link, rendered by the app
 * itself, and is never fetched as an "external" preview. The first three are
 * `lib/inputAssistance/pasteEventLinks.ts#PORTAVA_LINK_HOSTS` (a test holds this
 * set to be a superset of that one); the configured web origins and the storage
 * origin (`lib/mediaUrl.ts#configuredStorageOrigin`) are added at call time.
 */
const OWN_HOSTS: ReadonlySet<string> = new Set(["portava.replit.app", "portava.app", "www.portava.app"]);

export function portavaOwnHosts(env: NodeJS.ProcessEnv = process.env, storageOrigin: string | null = configuredStorageOrigin()): Set<string> {
  const out = new Set(OWN_HOSTS);
  for (const v of [env["PORTAVA_WEB_ORIGIN"], env["EXPO_PUBLIC_WEB_ORIGIN"], storageOrigin]) {
    const t = (v ?? "").trim();
    if (!t) continue;
    try { out.add(new URL(t).hostname.toLowerCase()); } catch { /* not an origin */ }
  }
  return out;
}

const URL_TOKEN = /(?<![A-Za-z0-9+.-])https?:\/\/[^\s<>"'`]+/gi;

function count(s: string, ch: string): number {
  let n = 0;
  for (const c of s) if (c === ch) n++;
  return n;
}

/** Sentence punctuation after a link is not part of it; a closing bracket is, only when the link opened one. */
function trimTrailing(token: string): string {
  let t = token;
  for (;;) {
    const last = t.slice(-1);
    if (/[.,;:!?]/.test(last)) { t = t.slice(0, -1); continue; }
    const open = last === ")" ? "(" : last === "]" ? "[" : last === "}" ? "{" : null;
    if (open && count(t, open) < count(t, last)) { t = t.slice(0, -1); continue; }
    return t;
  }
}

/**
 * The link a preview is made for: the FIRST `http(s)://` link in the body
 * whose host is not Portava's own. It is returned as written; whether it may
 * be fetched (https only, no IP, …) is `normalizePreviewUrl`'s decision, so a
 * first link that is `http:` means no preview rather than a preview of the
 * second link. Null when the body has no such link.
 */
export function firstExternalUrl(body: string, own: ReadonlySet<string> = portavaOwnHosts()): string | null {
  if (typeof body !== "string" || body.length === 0) return null;
  for (const match of body.matchAll(URL_TOKEN)) {
    const token = trimTrailing(match[0]);
    let host: string;
    try { host = new URL(token).hostname.replace(/\.$/, "").toLowerCase(); } catch { continue; }
    if (own.has(host)) continue;
    return token;
  }
  return null;
}

/** sha256 of the body's UTF-8 bytes, lowercase hex — identical to 3825's `encode(sha256(convert_to(body, 'UTF8')), 'hex')`. */
export function sourceDigest(body: string): string {
  return createHash("sha256").update(body, "utf8").digest("hex");
}

/** A message a preview may exist for: a plain text message (no structured kind). */
export function isPreviewableKind(msgType: unknown, subtype: unknown): boolean {
  return msgType === "text" && (subtype === null || subtype === undefined);
}

/** The instant the body was last written: the later of sent and edited. NaN when neither parses. */
export function bodyWrittenAt(createdAt: unknown, editedAt: unknown): number {
  const c = typeof createdAt === "string" ? Date.parse(createdAt) : NaN;
  const e = typeof editedAt === "string" ? Date.parse(editedAt) : NaN;
  if (Number.isNaN(c)) return NaN;
  return Number.isNaN(e) ? c : Math.max(c, e);
}

export interface StoredPreviewRow {
  message_id: string;
  thread_id?: string;
  status: string;
  url: string | null;
  host: string | null;
  title: string | null;
  description: string | null;
  site_name: string | null;
  source_digest: string;
}

/** What a client receives for one message. Text only: there is no image field to fill. */
export interface WirePreview {
  messageId: string;
  url: string;
  host: string;
  title: string;
  description: string;
  siteName: string;
}

const capped = (v: unknown, max: number): string => (typeof v === "string" ? v.slice(0, max) : "");

/**
 * The wire form of a stored row, or null when the row is not servable: not an
 * `ok` row, no url/host, or a digest that does not match the body the caller
 * read just now (an edit the trigger did not see, a restore, a race) — a
 * preview describes one body and is never shown beside another.
 */
export function servablePreview(row: StoredPreviewRow, currentBody: unknown): WirePreview | null {
  if (row.status !== "ok" || typeof row.url !== "string" || typeof row.host !== "string") return null;
  if (typeof currentBody !== "string" || currentBody.length === 0) return null;
  if (row.source_digest !== sourceDigest(currentBody)) return null;
  return {
    messageId: row.message_id,
    url: capped(row.url, PREVIEW_URL_MAX),
    host: capped(row.host, PREVIEW_HOST_MAX),
    title: capped(row.title, PREVIEW_TITLE_MAX),
    description: capped(row.description, PREVIEW_DESCRIPTION_MAX),
    siteName: capped(row.site_name, PREVIEW_SITE_NAME_MAX),
  };
}

/** Outcomes of 3825's `telegraph_store_link_preview`. A value outside this list is not an outcome. */
export const STORE_OUTCOMES = ["stored", "exists", "message_gone", "stale", "e2ee"] as const;
export type StoreOutcome = (typeof STORE_OUTCOMES)[number];
export function isStoreOutcome(v: unknown): v is StoreOutcome {
  return typeof v === "string" && (STORE_OUTCOMES as readonly string[]).includes(v);
}
