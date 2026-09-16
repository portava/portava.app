/**
 * Telegraph §6.2 — the thirteen message kinds, as validated envelopes.
 *
 * Spec §6.2, verbatim:
 *   TEXT · IMAGE · VIDEO · MEDIA_ALBUM · GIF · VOICE · MEMORY_NOTE ·
 *   PORTAVA_OBJECT · LOCATION · ACTION · ANNOUNCEMENT · SYSTEM · SAFETY
 *
 * ── WHY AN ENVELOPE AND NOT COLUMNS ─────────────────────────────────────────
 * `messages` carries four nullable media columns; `msg_type` is
 * `text NOT NULL DEFAULT 'text'` with NO CHECK
 * (`baseline/20260819_baseline_structure.sql:7565`). So a kind whose payload is
 * pure structured data costs no DDL and is true on every deployment of this
 * tree. An ASSET TYPE costs a migration.
 *
 * ── VOICE HAS ITS OWN DOOR, AND THAT IS A PROPERTY OF THE KIND ──────────────
 * VOICE was refused outright here until `2989_messages_audio_media_type.sql`
 * widened `messages.media_type` to admit `audio`. It is now a real envelope: it
 * validates, PARSES back out of a stored row, indexes into §6.4's VOICE drawer
 * tab, and renders.
 *
 * It is still not sent through `POST /threads/:id/typed-messages`, and that is
 * now a property of the kind. That route writes `body`, `msg_type` and
 * `subtype` and nothing else; a voice note also OWNS AN AUDIO OBJECT IN OUR
 * STORAGE and must write the media columns every consumer of message-owned
 * assets reads. So it has `routes/telegraphVoice.ts`, exactly as IMAGE, VIDEO
 * and PORTAVA_OBJECT have theirs, and `UNSENDABLE_KINDS` names it the same way.
 * `SENDABLE_ENVELOPE_KINDS` therefore means "sendable THROUGH THE TYPED ROUTE",
 * never "sendable at all"; `ENVELOPE_KINDS`, the parseable set, is larger.
 */
import { z } from "zod";

import { VoicePayload } from "./voice.js";
import {
  isTelegraphMessageKind,
  kindOfMsgType,
  msgTypeOf,
  type TelegraphMessageKind,
} from "./vocabulary.js";

// ── payloads ─────────────────────────────────────────────────────────────────

/** §6.2 MEDIA_ALBUM — "independent asset references", one reply target. */
export const MediaAlbumPayload = z.object({
  assets: z
    .array(
      z.object({
        url: z.string().min(1).max(2048),
        mediaType: z.enum(["image", "video"]),
        thumbnailUrl: z.string().max(2048).nullish(),
        durationSeconds: z.number().int().nonnegative().max(86_400).nullish(),
        width: z.number().int().positive().max(20000).nullish(),
        height: z.number().int().positive().max(20000).nullish(),
      }),
    )
    .min(2, "an album carries at least two assets; one asset is an IMAGE or VIDEO")
    .max(20),
  caption: z.string().max(500).nullish(),
});

/** §6.2 GIF — "distinct lightweight looping content". */
export const GifPayload = z.object({
  url: z.string().min(1).max(2048),
  /** A still frame, so a data-saver or reduced-motion viewer has something. */
  stillUrl: z.string().max(2048).nullish(),
  width: z.number().int().positive().max(20000).nullish(),
  height: z.number().int().positive().max(20000).nullish(),
  /** Provider attribution, where the provider requires it. */
  provider: z.string().max(40).nullish(),
  altText: z.string().max(300).nullish(),
});

/** §6.2 LOCATION — coarse by default; §4.3's precision ladder lives here. */
export const LocationPayload = z.object({
  label: z.string().min(1).max(200),
  /** Coarse area, always safe to show. */
  approximateLabel: z.string().max(200).nullish(),
  placeId: z.string().max(200).nullish(),
  /** Precision the SENDER chose. `exact` is opt-in per message, never default. */
  precision: z.enum(["area", "venue", "exact"]).default("area"),
  lat: z.number().min(-90).max(90).nullish(),
  lng: z.number().min(-180).max(180).nullish(),
  caption: z.string().max(500).nullish(),
});

/** §6.2 ACTION — a §8.1 action carried as a first-class message. */
export const ActionPayload = z.object({
  action: z.string().min(1).max(40),
  title: z.string().min(1).max(200),
  objectType: z.string().max(40).nullish(),
  objectId: z.string().max(200).nullish(),
  /** §8.2: an action message is a PROPOSAL until someone confirms it. */
  requiresConfirmation: z.literal(true).default(true),
  caption: z.string().max(500).nullish(),
});

/** §6.2 ANNOUNCEMENT — a crew-wide notice, optionally acknowledgeable. */
export const AnnouncementPayload = z.object({
  title: z.string().min(1).max(200),
  body: z.string().max(2000).nullish(),
  /** §11.2's "until acknowledged" applies to announcements too. */
  requiresAcknowledgement: z.boolean().default(false),
});

/** §6.2 SAFETY — a safety-class message, distinct from an ordinary one. */
export const SafetyPayload = z.object({
  kind: z.enum(["check_in", "heads_up", "need_help", "all_clear"]),
  label: z.string().min(1).max(200),
  /** Coarse only. A safety message must never require exact coordinates. */
  approximateLabel: z.string().max(200).nullish(),
  note: z.string().max(1000).nullish(),
});

/** §10.1 MemoryNoteShare, carried as §6.2's MEMORY_NOTE kind. */
export const MemoryNotePayload = z.object({
  memoryNoteId: z.string().min(1).max(200),
  authorId: z.string().min(1).max(200),
  text: z.string().max(2000).nullish(),
  voiceAssetId: z.string().max(200).nullish(),
  placeId: z.string().max(200).nullish(),
  occurredAt: z.string().max(64).nullish(),
  mediaAssetIds: z.array(z.string().max(200)).max(20).default([]),
  shareProjectionVersion: z.literal("1").default("1"),
});

const PAYLOADS = {
  MEDIA_ALBUM: MediaAlbumPayload,
  GIF: GifPayload,
  LOCATION: LocationPayload,
  ACTION: ActionPayload,
  ANNOUNCEMENT: AnnouncementPayload,
  SAFETY: SafetyPayload,
  MEMORY_NOTE: MemoryNotePayload,
  VOICE: VoicePayload,
} as const;

export type EnvelopeKind = keyof typeof PAYLOADS;

/** The kinds the TYPED-MESSAGE route sends. VOICE has its own route — see the header. */
export const SENDABLE_ENVELOPE_KINDS = (Object.keys(PAYLOADS) as EnvelopeKind[]).filter((k) => k !== "VOICE");

/** Every kind carried as a stored envelope — what `parseKindEnvelope` reads back. LARGER than the sendable set. */
export const ENVELOPE_KINDS = Object.keys(PAYLOADS) as EnvelopeKind[];

/** Kinds §6.2 names that the TYPED-MESSAGE route does not send, each with the reason: a reader must be
 *  able to tell "not built" from "sent elsewhere", and a caller gets the reason, not a generic 400. */
export const UNSENDABLE_KINDS: Readonly<Record<string, string>> = {
  VOICE:
    "VOICE is sent through POST /api/threads/:threadId/voice, after uploading the recording to " +
    "POST /api/telegraph/voice/upload. Not here: a voice note owns an audio object in our storage and must write messages.media_url / media_type / media_duration_seconds, which this route does not write.",
  TEXT: "TEXT is sent through POST /threads/:id/messages.",
  IMAGE: "IMAGE is sent through the media upload path.",
  VIDEO: "VIDEO is sent through the media upload path.",
  SYSTEM: "SYSTEM messages are written by the server, never by a client.",
  PORTAVA_OBJECT: "PORTAVA_OBJECT is sent through POST /threads/:id/share.",
};

export function isSendableEnvelopeKind(kind: unknown): kind is EnvelopeKind {
  return typeof kind === "string" && (SENDABLE_ENVELOPE_KINDS as string[]).includes(kind);
}
/** True for any kind carried as an envelope, whichever route wrote it. */
export function isEnvelopeKind(k: unknown): k is EnvelopeKind {
  return typeof k === "string" && (ENVELOPE_KINDS as string[]).includes(k);
}

// ── the envelope ─────────────────────────────────────────────────────────────

export const KIND_ENVELOPE_VERSION = "1" as const;

export interface KindEnvelope<K extends EnvelopeKind = EnvelopeKind> {
  kind: K;
  envelopeVersion: "1";
  payload: unknown;
}

export type ValidateResult =
  | { ok: true; envelope: KindEnvelope; msgType: string; subtype: string | null }
  | { ok: false; error: string };

/**
 * Validate a (kind, payload) pair into the row that will be written.
 *
 * `subtype` is the kind's own discriminator where the kind has one (SAFETY's
 * four classes, LOCATION's precision), so an existing renderer that switches on
 * `subtype` can tell them apart without parsing the body.
 */
export function validateKindMessage(kind: unknown, payload: unknown): ValidateResult {
  if (typeof kind !== "string" || !isTelegraphMessageKind(kind)) {
    return { ok: false, error: `Unknown message kind. §6.2 names: ${SENDABLE_ENVELOPE_KINDS.join(", ")}` };
  }
  if (!isSendableEnvelopeKind(kind)) {
    return { ok: false, error: UNSENDABLE_KINDS[kind] ?? `${kind} cannot be sent here` };
  }
  const schema = PAYLOADS[kind];
  const parsed = schema.safeParse(payload ?? {});
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? `Invalid ${kind} payload` };
  }
  return {
    ok: true,
    envelope: { kind, envelopeVersion: KIND_ENVELOPE_VERSION, payload: parsed.data },
    msgType: msgTypeOf(kind),
    subtype: subtypeFor(kind, parsed.data),
  };
}

function subtypeFor(kind: EnvelopeKind, payload: any): string | null {
  switch (kind) {
    case "SAFETY":
      return typeof payload?.kind === "string" ? payload.kind : null;
    case "LOCATION":
      return typeof payload?.precision === "string" ? payload.precision : null;
    case "ACTION":
      return typeof payload?.action === "string" ? payload.action.toLowerCase() : null;
    case "GIF":
      return typeof payload?.provider === "string" ? payload.provider.toLowerCase() : null;
    default:
      return null;
  }
}

/** Read a stored row back into its kind and payload. Anything odd is TEXT. */
export function parseKindEnvelope(
  msgType: string | null | undefined,
  body: string | null | undefined,
): { kind: TelegraphMessageKind; payload: unknown } | null {
  const kind = kindOfMsgType(msgType);
  if (!isEnvelopeKind(kind)) return null; // PARSEABLE, not typed-route-sendable: isSendableEnvelopeKind here degraded every stored VOICE row to TEXT.
  if (typeof body !== "string" || body.length === 0) return null;
  let parsed: any;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  if (!parsed || parsed.kind !== kind || parsed.envelopeVersion !== KIND_ENVELOPE_VERSION) return null;
  const schema = PAYLOADS[kind];
  const check = schema.safeParse(parsed.payload);
  if (!check.success) return null;
  return { kind, payload: check.data };
}

// ── §6.4 the content drawer's tabs ───────────────────────────────────────────

/** §6.4, verbatim: MEDIA | PLACES | PORTAVA | VOICE | GIFS | LINKS | FILES. */
export const DRAWER_TABS = ["MEDIA", "PLACES", "PORTAVA", "VOICE", "GIFS", "LINKS", "FILES"] as const;

export type DrawerTab = (typeof DRAWER_TABS)[number];

export function isDrawerTab(v: unknown): v is DrawerTab {
  return typeof v === "string" && (DRAWER_TABS as readonly string[]).includes(v);
}

/**
 * Which stored rows belong in which tab. This is a CLASSIFIER over rows the
 * thread already has — §6.4's "structured index over exchanged content, not a
 * second storage copy". Nothing here writes anything.
 */
export function drawerTabFor(row: {
  msg_type?: string | null;
  subtype?: string | null;
  media_type?: string | null;
  media_url?: string | null;
  body?: string | null;
}): DrawerTab | null {
  const kind = kindOfMsgType(row.msg_type);

  if (row.media_url && (row.media_type === "image" || row.media_type === "video")) return "MEDIA";
  if (kind === "MEDIA_ALBUM") return "MEDIA";
  if (kind === "GIF") return "GIFS";
  if (kind === "VOICE") return "VOICE";
  if (kind === "LOCATION") return "PLACES";
  if (kind === "PORTAVA_OBJECT") {
    const sub = (row.subtype ?? "").toLowerCase();
    return sub === "place" || sub === "hidden_gem" || sub === "map_pin" || sub === "meetup_point"
      ? "PLACES"
      : "PORTAVA";
  }
  // Legacy producers, mapped so an OLD card is indexed too.
  if (row.subtype === "discovery_card") return "PLACES";
  if (row.subtype === "post_card" || row.subtype === "compass_card") return "PORTAVA";
  if (typeof row.body === "string" && URL_RE.test(row.body)) return "LINKS";
  return null;
}

/** Deliberately narrow: an http(s) URL, not every string with a dot in it. */
export const URL_RE = /https?:\/\/[^\s<>"']+/i;

/** Every link in a body, de-duplicated and capped. */
export function extractLinks(body: string | null | undefined, cap = 10): string[] {
  if (typeof body !== "string") return [];
  const out: string[] = [];
  const re = /https?:\/\/[^\s<>"']+/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    const url = m[0].replace(/[.,)\]]+$/, "");
    if (!out.includes(url)) out.push(url);
    if (out.length >= cap) break;
  }
  return out;
}

// ── §6.4 object-aware search ─────────────────────────────────────────────────

/**
 * The searchable text of a row — the ONLY thing search matches on.
 *
 * A deleted or unsent row returns null, which is §6.4's "object-aware search
 * must respect current authorization and unsent/deleted state" and §7.4's
 * "remove from normal retrieval, SEARCH and projections". The predicate is
 * here, in one function, rather than spread across the query, so the rule can
 * be tested without a database.
 */
export function searchableTextOf(row: {
  body?: string | null;
  msg_type?: string | null;
  subtype?: string | null;
  deleted_at?: string | null;
  unsent_at?: string | null;
}): string | null {
  if (row.deleted_at) return null;
  // `unsent_at` does not exist in production; reading it costs nothing and
  // means this predicate is already correct on a database that has it.
  if ((row as any).unsent_at) return null;

  const kind = kindOfMsgType(row.msg_type);
  const body = typeof row.body === "string" ? row.body : "";

  if (kind === "TEXT" || kind === "SYSTEM") return body;

  const envelope = parseKindEnvelope(row.msg_type, body);
  if (envelope) {
    const p = envelope.payload as any;
    const parts = [p?.label, p?.title, p?.caption, p?.note, p?.body, p?.altText, p?.text, p?.approximateLabel]
      .filter((x) => typeof x === "string" && x.length > 0);
    return parts.join(" ") || null;
  }

  // A legacy card's searchable text is the sender-authored fields of its JSON,
  // never the whole blob — ids and urls are not what a person searches for.
  try {
    const parsed = JSON.parse(body);
    const parts = [parsed?.title, parsed?.caption, parsed?.blurb, parsed?.snippet, parsed?.city, parsed?.name]
      .filter((x) => typeof x === "string" && x.length > 0);
    return parts.join(" ") || null;
  } catch {
    return body || null;
  }
}

/** Case- and diacritic-insensitive containment. */
export function matchesQuery(text: string | null, query: string): boolean {
  if (!text) return false;
  const norm = (s: string) =>
    s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  return norm(text).includes(norm(query));
}
