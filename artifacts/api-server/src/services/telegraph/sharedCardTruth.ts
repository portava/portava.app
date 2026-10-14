/**
 * Telegraph shared-card truth — census-telegraph T448 / T359 / T445 / T409
 * (lane w-tg-cardtruth, 2026-10-14).
 *
 * THE DEFECT
 * ==========
 * The legacy shared cards store a SNAPSHOT of their source in `messages.body`:
 * a Discovery card carries the place's title, city, blurb and image as the
 * sender saw them; a post card the post's text, author, avatar, counts and
 * place; a Compass card the recommendation's title, city and description; the
 * hidden-gem card the gem's name, neighbourhood, sensitivity and tags; the
 * event card the event's title, start, city and visibility; the booking card the
 * booking's date, city and price; a meetup card its title and place; a Circle
 * meeting-point card the venue label. §5.3 made two CLIENT cards re-resolve
 * (`useShareRevocation`), but every SERVER reader still handed the snapshot to
 * whoever asked: the thread read (body, the translated body, the reply quote),
 * the group-chat read, saved messages, edit history, the inbox preview, the
 * drawer and in-thread search, §21 search, and Compass's `getSharedPlaces` and
 * search tools. A place made private, a post deleted, a gem withdrawn, a
 * blocker's post — all still readable through any of those doors, and all
 * presented as current (census T448: "historical card text is still served AS
 * CURRENT").
 *
 * THE RULE
 * ========
 * A reader exposes NOTHING source-derived from a card's stored body. It
 * re-resolves the card's source for the CURRENT viewer through §5's loaders —
 * the one place each family's privacy rule lives (blocks either way, post
 * publication, gem disclosure, event eligibility, memory read policy, booking
 * parties) — and serves one of three forms:
 *
 *   live         the §5 projection, written into the card's own legacy shape so
 *                an installed client draws the CURRENT title rather than the
 *                sender's, plus the sender's own caption;
 *   unavailable  the reference and the caption only — the source is deleted,
 *                private, unauthorized, not found, or COULD NOT BE READ
 *                (`unknown`). A failed read is never the snapshot and never an
 *                empty card;
 *   withheld     the reference and the caption only — the card names no source
 *                this server can resolve (a Compass `place:` id from
 *                `discovery_places`, which has no §5 family; a `for_you` pick;
 *                a meeting-point card, which carries no reference at all).
 *                Fail closed: what cannot be re-checked is not shown.
 *
 * Batching: `resolveSharedCards` resolves a whole page in ONE pass — distinct
 * sources only, every loader concurrently, through `coalescingClient` so the
 * loaders' row and pair reads are issued as one `.in()` per table rather than
 * one per card. The client no longer needs a request per card either: the
 * truth rides on the message (`card`).
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  resolveShareProjections,
  type ResolvedShare,
  type ShareLog,
  type ShareRef,
  type TelegraphShareProjection,
  type UnavailableReason,
} from "./shareables.js";
import type { TelegraphAction, TelegraphObjectType } from "./vocabulary.js";
import { coalescingClient, type CoalescingStats } from "./coalescedReads.js";

// ── the registry ─────────────────────────────────────────────────────────────

export const SHARED_CARD_KINDS = [
  "discovery_card",
  "post_card",
  "compass_card",
  "hidden_gem_card",
  "event_context_card",
  "booking_card",
  "meetup_card",
  "circle_status_card",
] as const;
export type SharedCardKind = (typeof SHARED_CARD_KINDS)[number];

type Body = Record<string, unknown>;

export interface SharedCardSpec {
  /** How a row is recognised: the message type(s) and the subtype(s) it carries. */
  readonly msgTypes: readonly string[];
  /** `null` = any subtype under these message types. */
  readonly subtypes: readonly string[] | null;
  /** The §5 reference the body names, or null when it names none this server can resolve. */
  readonly refOf: (body: Body) => ShareRef | null;
  /** Fields that ARE the reference or the card's own discriminator — never source content. */
  readonly referenceFields: readonly string[];
  /** Fields the SENDER wrote (their caption) — theirs to show, not the source's. */
  readonly senderFields: readonly string[];
  /** The live form, in this card's legacy shape, drawn ONLY from the server's projection. */
  readonly liveFields: (p: TelegraphShareProjection, status: string) => Body;
  /** Why this card exists and who writes it — the registry is read by people too. */
  readonly note: string; /** Fix round 1: when set, the NON-live form is this plain sentence, not JSON — for kinds an installed client prints as a plain pill or bubble (never as an actionable card), so an older build shows words instead of the withheld JSON. Names nothing from the source. */ readonly withheldLabel?: string;
}

const str = (v: unknown): string | null => (typeof v === "string" && v.trim().length > 0 && v.length <= 200 ? v.trim() : null);

/**
 * The legacy `discovery_card.sourceType` vocabulary, mapped to §5 families.
 * Mirrors `legacySourceTypeToObjectType` in the client's `shareApi.ts`, so the
 * server and an installed client resolve the same card against the same family.
 * `for_you`, `traveler_pick` and `discovery` map to nothing: the id they carry
 * is not a key of any §5 family.
 */
export function legacySourceTypeToObjectType(sourceType: unknown): TelegraphObjectType | null {
  if (typeof sourceType !== "string") return null;
  switch (sourceType.toLowerCase()) {
    case "hidden_gem":
    case "gem":
      return "HIDDEN_GEM";
    case "place":
    case "venue":
      return "PLACE";
    case "post":
      return "POST";
    case "trip":
      return "TRIP";
    case "event":
      return "EVENT";
    case "meetup":
      return "MEETUP";
    case "memory":
      return "MEMORY";
    default:
      return null;
  }
}

/**
 * A Compass card's `cardType` + `id` (GET /compass/telegraph's projection of a
 * hydrated Compass item: events are bare ids, hidden gems `gem:<id>`, places
 * `place:<id>` of `discovery_places`).
 *
 * `place` is deliberately NOT mapped to PLACE: a `discovery_places` id is not a
 * `places` id, and resolving it there would answer `not_found` — telling the
 * viewer a live place was removed. No §5 family reads `discovery_places`, so the
 * honest answer is `withheld`.
 */
export function compassCardRef(body: Body): ShareRef | null {
  const id = str(body.id);
  const cardType = str(body.cardType) ?? (str(body.type) !== "compass_card" ? str(body.type) : null);
  if (!id || !cardType) return null;
  switch (cardType) {
    case "event":
      return id.includes(":") ? null : { objectType: "EVENT", objectId: id };
    case "hidden_gem":
      return id.startsWith("gem:") && id.length > 4 ? { objectType: "HIDDEN_GEM", objectId: id.slice(4) } : null;
    default:
      return null;
  }
}

const caption = ["caption"] as const;

export const SHARED_CARD_REGISTRY: Readonly<Record<SharedCardKind, SharedCardSpec>> = {
  discovery_card: {
    msgTypes: ["system", "text"],
    subtypes: ["discovery_card"],
    refOf: (b) => {
      const t = legacySourceTypeToObjectType(b.sourceType);
      const id = str(b.sourceId);
      return t && id ? { objectType: t, objectId: id } : null;
    },
    referenceFields: ["sourceId", "sourceType"],
    senderFields: caption,
    liveFields: (p) => ({
      title: p.title,
      category: p.objectType.toLowerCase(),
      city: p.subtitle ?? "",
      ...(p.imageUrl ? { imageUrl: p.imageUrl } : {}),
    }),
    note: "Client-authored by DiscoveryShareSheet; carried a snapshot of title, category, city, blurb, image and price.",
  },
  post_card: {
    msgTypes: ["system", "text"],
    subtypes: ["post_card"],
    refOf: (b) => (str(b.postId) ? { objectType: "POST", objectId: str(b.postId)! } : null),
    referenceFields: ["postId"],
    senderFields: caption,
    liveFields: (p) => ({
      // `title` too, so a search index reads the post's CURRENT text the way it
      // reads every other card's title; the installed card draws `snippet`.
      title: p.title,
      snippet: p.title,
      ...(p.subtitle && p.subtitle.startsWith("@") ? { authorHandle: p.subtitle.slice(1) } : {}),
      ...(p.imageUrl ? { thumbnail: p.imageUrl } : {}),
    }),
    note: "Client-authored by ShareSheet; carried the post's text, author name/handle/avatar, thumbnail, city, country and counts.",
  },
  compass_card: {
    msgTypes: ["system", "text"],
    subtypes: ["compass_card"],
    refOf: compassCardRef,
    // `type` is NOT kept on the withheld form on purpose: CompassCardMessage
    // draws its title from `title ?? category ?? type`, so an installed client
    // given `{type:"compass_card"}` would print the discriminator as a title.
    // Without `type` it draws its own "Compass recommendation" fallback.
    referenceFields: ["id", "cardType"],
    senderFields: [],
    liveFields: (p) => ({
      type: "compass_card",
      title: p.title,
      city: p.subtitle,
      category: null,
      description: null,
      imageUrl: p.imageUrl,
    }),
    note: "Client-authored from the Ask Compass tray; carried title, city, category, description and image.",
  },
  hidden_gem_card: {
    msgTypes: ["card"],
    subtypes: ["hidden_gem"],
    refOf: (b) => (str(b.gemId) ? { objectType: "HIDDEN_GEM", objectId: str(b.gemId)! } : null),
    referenceFields: ["type", "gemId"],
    senderFields: [],
    liveFields: (p) => ({ name: p.title, area: p.subtitle }),
    note: "Server-authored by POST /hidden-gems/:id/share; carried name, category, city, country, neighbourhood, sensitivity, verification, price, tags and a sentence naming the gem.", withheldLabel: "A shared hidden gem that can’t be shown right now.",
  },
  event_context_card: {
    msgTypes: ["system", "text"],
    subtypes: ["event_context_card"],
    refOf: (b) => (str(b.eventId) ? { objectType: "EVENT", objectId: str(b.eventId)! } : null),
    referenceFields: ["type", "eventId"],
    senderFields: [],
    liveFields: (p, status) => ({ title: p.title, subtitle: p.subtitle, state: status }),
    note: "Server-authored when an event's chat thread is created; carried title, start, city and visibility.", withheldLabel: "Event details that can’t be shown right now.",
  },
  booking_card: {
    msgTypes: ["booking_card"],
    subtypes: null,
    refOf: (b) => (str(b.booking_id) ? { objectType: "BOOKING", objectId: str(b.booking_id)! } : null),
    // `status` is the TRANSITION this card records (it is also the row's
    // `booking_status_<x>` subtype), and the two sentences are fixed server
    // copy — none of the three is read from the booking. `currentStatus` is.
    referenceFields: ["booking_id", "status", "cancellation_policy", "safety_reminder"],
    senderFields: [],
    liveFields: (p, status) => ({ title: p.title, date: p.subtitle, currentStatus: status }),
    note: "Server-authored by emitBookingCard on each status transition; carried date, time, duration, city, category and total.", withheldLabel: "A booking update that can’t be shown right now.",
  },
  meetup_card: {
    msgTypes: ["system", "text"],
    subtypes: ["meetup", "meetup_confirmed", "meetup_cancelled"],
    refOf: (b) => (str(b.meetupId) ? { objectType: "MEETUP", objectId: str(b.meetupId)! } : null),
    referenceFields: ["type", "meetupId"],
    senderFields: [],
    liveFields: (p) => ({ title: p.title, ...(p.subtitle ? { where: p.subtitle } : {}) }),
    note: "Client-authored meetup card (and its confirmed/cancelled notices); carried title, place, time block, date and names.", withheldLabel: "A shared meetup that can’t be shown right now.",
  },
  circle_status_card: {
    msgTypes: ["circle_status_card"],
    subtypes: null,
    // No reference: routes/circle.ts writes `{subtype, venueLabel?, approxArea?}`
    // and nothing that names the meeting point. Until a card carries one, its
    // labels cannot be re-checked — and every thread member, Circle member or
    // not, was served them.
    refOf: () => null,
    referenceFields: ["subtype"],
    senderFields: [],
    liveFields: () => ({}),
    note: "Server-authored by routes/circle.ts postCircleStatusCard; a meeting-point card carried the venue and area labels.",
  },
};

// ── recognising a card ───────────────────────────────────────────────────────

export interface CardRowLike {
  id?: unknown;
  thread_id?: unknown;
  msg_type?: unknown;
  subtype?: unknown;
  body?: unknown;
  deleted_at?: unknown;
}

function lower(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v.toLowerCase() : null;
}

/** Parse a stored body. Anything that is not a JSON object is null. */
export function parseCardBody(body: unknown): Body | null {
  if (typeof body !== "string") return null;
  const t = body.trim();
  if (!t.startsWith("{")) return null;
  try {
    const parsed = JSON.parse(t);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Body) : null;
  } catch {
    return null;
  }
}

/**
 * Which shared card a row is, or null.
 *
 * Keyed on BOTH columns: `subtype` alone is ambiguous — a §6.2 PORTAVA_OBJECT
 * row's subtype is its lowercased family (`hidden_gem`, `meetup`), and an
 * ACTION's subtype is its verb — so only the message types a legacy card is
 * actually written under are read. A `text` row whose JSON body says
 * `type:"meetup_card"` is a card too: the thread screen's own parser draws it as
 * one (`parseMeetupCard`'s legacy fallback), so the server must treat it as one.
 */
export function sharedCardKindOf(row: CardRowLike): SharedCardKind | null {
  const mt = lower(row.msg_type) ?? "text";
  const st = lower(row.subtype);
  for (const kind of SHARED_CARD_KINDS) {
    const spec = SHARED_CARD_REGISTRY[kind];
    if (!spec.msgTypes.includes(mt)) continue;
    if (spec.subtypes === null || (st !== null && spec.subtypes.includes(st))) return kind;
  }
  if ((mt === "text" || mt === "system") && st === null) {
    const parsed = parseCardBody(row.body);
    if (parsed && parsed.type === "meetup_card") return "meetup_card";
  }
  return null;
}

export function isSharedCardRow(row: CardRowLike): boolean {
  return sharedCardKindOf(row) !== null;
}

// ── the truth ────────────────────────────────────────────────────────────────

export type SharedCardTruth =
  | {
      kind: SharedCardKind;
      state: "live";
      objectType: TelegraphObjectType;
      objectId: string;
      status: string;
      projection: TelegraphShareProjection;
      actions: TelegraphAction[];
      deepLink: string;
    }
  | {
      kind: SharedCardKind;
      state: "unavailable";
      objectType: TelegraphObjectType;
      objectId: string;
      reason: UnavailableReason;
      deepLink: string;
    }
  | { kind: SharedCardKind; state: "withheld"; reason: "no_source" };

function pick(body: Body | null, fields: readonly string[]): Body {
  const out: Body = {};
  if (!body) return out;
  for (const f of fields) {
    const v = body[f];
    if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") out[f] = v;
  }
  return out;
}

/**
 * The body a reader may serve for this card under this truth. Never a field the
 * sender serialised from the source: only the reference, the sender's caption,
 * and — when live — the server's projection in the card's own shape.
 */
export function servedCardBody(kind: SharedCardKind, body: Body | null, truth: SharedCardTruth): string {
  const spec = SHARED_CARD_REGISTRY[kind];
  const kept = { ...pick(body, spec.referenceFields), ...pick(body, spec.senderFields) };
  if (truth.state === "live") return JSON.stringify({ ...kept, ...spec.liveFields(truth.projection, truth.status) });
  return spec.withheldLabel ?? JSON.stringify({ ...kept, withheld: true }); // fix round 1: a plain neutral sentence where an installed client would otherwise print the withheld JSON
}

/**
 * The withheld form, WITHOUT resolving — for surfaces that never need the
 * source's content: an inbox preview (the client labels a card by its kind),
 * an old version in edit history (a past body is not current state). Returns
 * null for a row that is not a shared card.
 */
export function withheldCardBody(row: CardRowLike): string | null {
  const kind = sharedCardKindOf(row);
  if (!kind || typeof row.body !== "string") return null;
  return servedCardBody(kind, parseCardBody(row.body), { kind, state: "withheld", reason: "no_source" });
}

/** Text a search index may hold for a card: the live projection and the sender's caption, nothing else. */
export function sharedCardIndexText(truth: SharedCardTruth | undefined, row: CardRowLike): string | null {
  if (!truth || truth.state !== "live") return null;
  const cap = pick(parseCardBody(row.body), ["caption"]).caption;
  return [truth.projection.title, truth.projection.subtitle, typeof cap === "string" ? cap : null]
    .filter((s): s is string => typeof s === "string" && s.trim().length > 0)
    .join(" · ");
}

function truthOf(kind: SharedCardKind, r: ResolvedShare): SharedCardTruth {
  if (r.available) {
    return {
      kind,
      state: "live",
      objectType: r.objectType,
      objectId: r.objectId,
      status: r.status,
      projection: r.projection,
      actions: r.actions,
      deepLink: r.deepLink,
    };
  }
  return { kind, state: "unavailable", objectType: r.objectType, objectId: r.objectId, reason: r.reason, deepLink: r.deepLink };
}

export interface CardEntry {
  row: CardRowLike;
  /** The conversation the card is being read in. Falls back to `row.thread_id`. */
  threadId?: string | null;
}

/**
 * Resolve every shared card among `entries` for `viewerId`, in one pass.
 * Returns truth keyed by message id; a row that is not a card has no entry, a
 * deleted row or a body that is not text has none either (it serves no body).
 */
export async function resolveSharedCards(
  client: SupabaseClient,
  viewerId: string,
  entries: readonly CardEntry[],
  log?: ShareLog,
  stats?: CoalescingStats,
): Promise<Map<string, SharedCardTruth>> {
  const out = new Map<string, SharedCardTruth>();
  type Job = { threadId: string; ref: ShareRef; waiting: Array<{ id: string; kind: SharedCardKind }> };
  const jobs = new Map<string, Job>();

  for (const { row, threadId } of entries) {
    if (row.deleted_at || typeof row.body !== "string") continue;
    const kind = sharedCardKindOf(row);
    if (!kind) continue;
    const id = String(row.id ?? "");
    if (!id) continue;
    const named = SHARED_CARD_REGISTRY[kind].refOf(parseCardBody(row.body) ?? {});
    // Fix round 1 (F1): a source id is resolved only in its canonical form —
    // the Discovery feed's `db/<uuid>` is the place it names — and an id that
    // is still not a uuid names nothing a §5 family can read. It is withheld
    // here rather than sent to a uuid column, where PostgREST answers 22P02 and
    // — batched — would turn EVERY card of that table on the page into `unknown`.
    const objectId = named ? normalizeSourceId(named.objectId) : null;
    const ref = named && objectId ? { ...named, objectId } : null;
    const thread = String(threadId ?? row.thread_id ?? "");
    if (!ref || !thread) {
      out.set(id, { kind, state: "withheld", reason: "no_source" });
      continue;
    }
    const jk = `${thread}\u0000${ref.objectType}\u0000${ref.objectId}`;
    const job = jobs.get(jk) ?? { threadId: thread, ref, waiting: [] };
    job.waiting.push({ id, kind });
    jobs.set(jk, job);
  }
  if (jobs.size === 0) return out;

  const batched = coalescingClient(client as unknown as object, stats) as unknown as SupabaseClient;
  await Promise.all(
    [...jobs.values()].map(async (job) => {
      let resolved: ResolvedShare | null = null;
      try {
        [resolved] = await resolveShareProjections(batched, viewerId, job.threadId, [job.ref], log);
      } catch (err) {
        log?.error({ err, objectType: job.ref.objectType }, "shared card: source resolve threw — served as unavailable/unknown");
      }
      for (const w of job.waiting) {
        out.set(
          w.id,
          resolved
            ? truthOf(w.kind, resolved)
            : {
                kind: w.kind,
                state: "unavailable",
                objectType: job.ref.objectType,
                objectId: job.ref.objectId,
                reason: "unknown",
                deepLink: "/",
              },
        );
      }
    }),
  );
  return out;
}

/**
 * The one call every reader makes: resolve the page's cards and hand back the
 * rows with each card's body replaced by what this viewer may be served. Rows
 * that are not cards are returned as they were (same objects). The truth map is
 * returned beside them so a reader can put it on the wire as `card`.
 */
export async function applySharedCardTruth<R extends CardRowLike>(
  client: SupabaseClient,
  viewerId: string,
  rows: readonly R[],
  opts: { threadId?: string | null; log?: ShareLog; stats?: CoalescingStats } = {},
): Promise<{ rows: R[]; truth: Map<string, SharedCardTruth> }> {
  const truth = await resolveSharedCards(
    client,
    viewerId,
    rows.map((row) => ({ row, threadId: opts.threadId ?? null })),
    opts.log,
    opts.stats,
  );
  if (truth.size === 0) return { rows: [...rows], truth };
  return {
    rows: rows.map((row) => {
      const t = truth.get(String(row.id ?? ""));
      if (!t) return row;
      return { ...row, body: servedCardBody(t.kind, parseCardBody(row.body), t) };
    }),
    truth,
  };
}

/**
 * A title a door may COPY out of a shared card into something that outlives the
 * message — a Memory draft. The live projection's title for this viewer, or
 * null (the caller's own neutral default). Never a field of the snapshot: a
 * copied snapshot is the backdoor with a longer lifetime.
 */
export async function sharedCardTitleFor(
  client: SupabaseClient,
  viewerId: string,
  row: CardRowLike,
  log?: ShareLog,
): Promise<string | null> {
  const t = (await resolveSharedCards(client, viewerId, [{ row }], log)).get(String(row.id ?? ""));
  return t && t.state === "live" ? t.projection.title : null;
}

// ── fix round 1 (verifier F1): the canonical form of a card's source id ─────
//
// `routes/discovery.ts` serves a canonical place as `id: "db/<uuid>"` (the bare
// uuid only in `canonicalPlaceId`), and the For-You tab shares `item.place.id`,
// so a Discovery card's `sourceId` is very often `db/<uuid>`. Every §5 family
// keys its source table by uuid. So: strip the feed's `db/` prefix, and refuse
// anything that is then not a uuid — the card is `withheld`, never a query.
const SOURCE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function normalizeSourceId(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const t = raw.trim();
  const id = t.startsWith("db/") ? t.slice(3) : t;
  return SOURCE_UUID.test(id) ? id : null;
}
