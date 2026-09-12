/**
 * Telegraph §21 — the search contract.
 *
 * §21, in full:
 *   "Telegraph search is object-aware and authorization-scoped.
 *      SEARCH "sky36"
 *      MESSAGES 3 / PLACES 1 / MEDIA 2 videos / PLANS 1 / MEMORIES 1
 *    Index message text, permitted voice/video transcripts, object titles and
 *    safe metadata.
 *    Private semantic indexes require access filtering BEFORE retrieval, not
 *    post-filtering after unrestricted search.
 *    Unsent/deleted/revoked objects must be removed from normal user search and
 *    Compass retrieval.
 *    'Ask this conversation' should prefer structured plans/decisions/actions
 *    over inferred prose."
 *
 * census-telegraph T272-T277 measured all six as absent: `routes/messaging.ts`
 * has no search route, `routes/groupChat.ts` has none, and the inbox filter
 * (`components/TelegraphInboxScreen.tsx`) filters threads that are ALREADY
 * loaded, client-side. This file is the contract the implementation answers.
 *
 * OBJECT-AWARE MEANS THE BUCKET IS DERIVED, NOT DECLARED
 * =====================================================
 * A message is not "a place" because someone tagged it. It is a place because
 * its `subtype` is one of the card kinds that carry a place, and the classifier
 * below is the single place that decision is made — so a new card subtype that
 * nobody classifies lands in MESSAGES (visible, searchable, uncategorised)
 * rather than silently vanishing from every bucket.
 *
 * SAFE METADATA IS AN ALLOWLIST
 * =============================
 * §21 asks for "object titles and safe metadata" to be indexed. Card bodies are
 * unversioned JSON (T157) and contain, among other things, coordinates. The
 * extractor below is an ALLOWLIST of field names, not a denylist of forbidden
 * ones: a card that gains a `lat` field tomorrow is not indexed by accident,
 * because `lat` was never on the list. A denylist would have to be updated by
 * whoever adds the field, which is exactly the person who will not remember.
 */

/** §21's five result types, in the order the spec prints them. */
export const TELEGRAPH_SEARCH_BUCKETS = ["MESSAGES", "PLACES", "MEDIA", "PLANS", "MEMORIES"] as const;
export type TelegraphSearchBucket = (typeof TELEGRAPH_SEARCH_BUCKETS)[number];

/**
 * Which message `subtype` lands in which bucket.
 *
 * Subtypes are the ones actually written by this repository — found by reading
 * the writers, not by guessing: `routes/circle.ts` (`meeting_point`, `arrived`,
 * `meetup_confirmed`, `meetup_cancelled`, `hidden_gem`), `routes/messaging.ts`
 * (`discovery_card`, `post_card`, `event_context_card`), `routes/telegraph.ts`
 * (`compass_card`), the call subtypes, and `app/messages/[id].tsx` (`meetup`).
 */
export const SUBTYPE_BUCKET: Readonly<Record<string, TelegraphSearchBucket>> = {
  discovery_card: "PLACES",
  hidden_gem: "PLACES",
  meeting_point: "PLACES",
  compass_card: "PLACES",
  meetup: "PLANS",
  meetup_confirmed: "PLANS",
  meetup_cancelled: "PLANS",
  event_context_card: "PLANS",
  post_card: "MEMORIES",
  memory_card: "MEMORIES",
};

/**
 * Structured kinds, for §21's last line. "Ask this conversation" prefers these
 * over prose, and this set is what "structured" means — not a vibe.
 */
export const STRUCTURED_SUBTYPES: ReadonlySet<string> = new Set([
  "meetup", "meetup_confirmed", "meetup_cancelled", "event_context_card",
  "meeting_point", "discovery_card", "hidden_gem", "compass_card",
]);

/**
 * Card body fields that may be indexed and echoed. Allowlist — see the header.
 * Nothing positional, nothing identifying beyond a title, nothing that is a URL
 * to a private object.
 */
export const SAFE_CARD_FIELDS: readonly string[] = [
  "title", "name", "placeName", "venueName", "label", "caption", "summary",
  "city", "neighborhood", "category", "when", "dateLabel",
];

export interface TelegraphSearchHit {
  messageId: string;
  conversationId: string;
  bucket: TelegraphSearchBucket;
  senderId: string;
  createdAt: string;
  /** The matched text, already truncated. Never the whole card JSON. */
  snippet: string;
  /** For card hits: the object's title as the allowlist found it. */
  objectTitle: string | null;
  subtype: string | null;
  msgType: string;
  hasMedia: boolean;
}

export interface TelegraphSearchResult {
  query: string;
  /** Per-bucket counts, always all five keys, so "0 PLACES" is expressible. */
  counts: Record<TelegraphSearchBucket, number>;
  hits: TelegraphSearchHit[];
  /** How many conversations the caller was authorized to search at all. */
  conversationsSearched: number;
  /**
   * How many conversations were searched under a §14.3 lower bound. Reported
   * because a zero-result search over bounded threads is a different fact from
   * a zero-result search over unbounded ones, and a user who cannot see why
   * their own message is missing will assume the search is broken.
   */
  conversationsBounded: number;
  /**
   * True when an input read failed. The result is then a FLOOR — some hits may
   * be missing — and saying so is the difference between "nothing matched" and
   * "we could not look everywhere".
   */
  degraded: boolean;
}

/** An empty result with every bucket present. */
export function emptySearchResult(query: string): TelegraphSearchResult {
  const counts = {} as Record<TelegraphSearchBucket, number>;
  for (const b of TELEGRAPH_SEARCH_BUCKETS) counts[b] = 0;
  return { query, counts, hits: [], conversationsSearched: 0, conversationsBounded: 0, degraded: false };
}

/**
 * Classify one message row into a bucket.
 *
 * Order matters and is stated: a card that ALSO carries media is still its card
 * bucket, because "the plan you shared" is what a user is looking for, and the
 * photo attached to it is not a separate object they remember. Only a message
 * whose whole content is media is MEDIA.
 */
export function classifyMessage(row: {
  msg_type?: string | null;
  subtype?: string | null;
  media_url?: string | null;
}): TelegraphSearchBucket {
  const subtype = (row.subtype ?? "").trim();
  const mapped = subtype ? SUBTYPE_BUCKET[subtype] : undefined;
  if (mapped) return mapped;
  if (row.media_url || (row.msg_type ?? "") === "media") return "MEDIA";
  return "MESSAGES";
}

/**
 * Pull the indexable, echo-safe text out of a message body.
 *
 * A plain message body is its own text. A card body is unversioned JSON
 * (T157) — so it is parsed, and only `SAFE_CARD_FIELDS` are read. A body that
 * looks like JSON and is not parseable yields the empty string rather than the
 * raw JSON, because echoing an unparsed card body back to a searcher is exactly
 * how a coordinate leaks.
 */
export function indexableText(body: string | null | undefined, subtype: string | null | undefined): {
  text: string;
  objectTitle: string | null;
} {
  const raw = (body ?? "").trim();
  if (raw === "") return { text: "", objectTitle: null };
  const looksStructured = raw.startsWith("{") || raw.startsWith("[");
  if (!looksStructured) return { text: raw, objectTitle: null };

  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return { text: "", objectTitle: null }; }
  if (parsed === null || typeof parsed !== "object") return { text: "", objectTitle: null };

  const obj = parsed as Record<string, unknown>;
  const parts: string[] = [];
  let title: string | null = null;
  for (const field of SAFE_CARD_FIELDS) {
    const v = obj[field];
    if (typeof v === "string" && v.trim() !== "") {
      parts.push(v.trim());
      if (title === null && (field === "title" || field === "name" || field === "placeName" || field === "venueName")) {
        title = v.trim();
      }
    }
  }
  // One level down: cards nest their payload under `place`, `plan` or `data`.
  for (const nestKey of ["place", "plan", "event", "data", "payload"]) {
    const nested = obj[nestKey];
    if (nested && typeof nested === "object") {
      for (const field of SAFE_CARD_FIELDS) {
        const v = (nested as Record<string, unknown>)[field];
        if (typeof v === "string" && v.trim() !== "") {
          parts.push(v.trim());
          if (title === null && (field === "title" || field === "name" || field === "placeName" || field === "venueName")) {
            title = v.trim();
          }
        }
      }
    }
  }
  void subtype;
  return { text: parts.join(" · "), objectTitle: title };
}
