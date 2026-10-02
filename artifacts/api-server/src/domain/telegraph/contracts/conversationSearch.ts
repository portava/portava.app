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

import { dispatchTable, lookup } from "./dispatchTable.js";

/** §21's five result types, in the order the spec prints them. */
export const TELEGRAPH_SEARCH_BUCKETS = ["MESSAGES", "PLACES", "MEDIA", "PLANS", "MEMORIES"] as const;
export type TelegraphSearchBucket = (typeof TELEGRAPH_SEARCH_BUCKETS)[number];

// ── §606's SIXTH capability: search behaviour, registered by OBJECT FAMILY ───
//
// Telegraph §606: "Every shareable Portava domain registers preview,
// authorization, current state, actions, SEARCH BEHAVIOR, and revocation
// through a Telegraph content capability contract."
//
// Five of those six were registered through `services/telegraph/shareables.ts`
// — one `LOADERS` entry per object family, giving `getSharePreview`,
// `getCurrentState`, `getAvailableActions`, `getDeepLink` and, through the
// re-resolve, revocation. Search behaviour was not: it lived HERE, in a map
// keyed by MESSAGE SUBTYPE, declared independently of the families beside it.
//
// TWO REGISTRIES KEYED DIFFERENTLY IS THE DEFECT, not an untidiness. A domain
// that registered a loader did not thereby become searchable, and nothing could
// tell it had not: `MAP_PIN` and `MEETUP_POINT` are in `LOADERS` and were in
// neither map here, so a Discovery pin shared into a thread had a preview, an
// authorization check, a live state and a revocation — and no bucket. The two
// maps could disagree about a family forever without a single failure, because
// nothing read them together. census-discovery A20.
//
// So the registration moves to the key the contract already uses — the object
// family — and the subtype maps below are DERIVED from it. A family added to
// `LOADERS` with no entry here answers `null` from `getSearchBehaviour()`, which
// is a checkable absence rather than a silent one.
export interface TelegraphSearchBehaviour {
  /** Which of §21's five buckets a hit on this family lands in. */
  bucket: TelegraphSearchBucket;
  /** §21's last line: "prefer structured plans/decisions/actions over inferred prose." */
  structured: boolean;
  /**
   * The message `subtype` values this family is actually carried by in this
   * tree — read off the writers, never guessed. An empty list is a real and
   * common answer: the family is shareable and no card subtype carries it yet.
   */
  carriedBy: readonly string[];
}

/**
 * The registration, one entry per shareable object family.
 *
 * Keys are `TelegraphObjectType` values written as plain strings ON PURPOSE:
 * this module is in `domain/`, `vocabulary.ts` is in `services/`, and
 * check:telegraph-package-boundaries refuses that import. The agreement is
 * asserted from the other side instead — `services/telegraph/shareables.ts`
 * types its lookup with `TelegraphObjectType`, and the contract test walks
 * every key here through `isTelegraphObjectType`, so a typo fails a test rather
 * than registering a family that does not exist.
 */
export const SEARCH_BEHAVIOUR: Readonly<Record<string, TelegraphSearchBehaviour>> = dispatchTable({
  // Places — Discovery's three families and the meetup point.
  PLACE:        { bucket: "PLACES",   structured: true,  carriedBy: ["discovery_card"] },
  HIDDEN_GEM:   { bucket: "PLACES",   structured: true,  carriedBy: ["hidden_gem"] },
  MEETUP_POINT: { bucket: "PLACES",   structured: true,  carriedBy: ["meeting_point"] },
  MAP_PIN:      { bucket: "PLACES",   structured: true,  carriedBy: [] },
  // Travel.
  MEETUP:       { bucket: "PLANS",    structured: true,  carriedBy: ["meetup", "meetup_confirmed", "meetup_cancelled"] },
  EVENT:        { bucket: "PLANS",    structured: true,  carriedBy: ["event_context_card"] },
  PLAN:         { bucket: "PLANS",    structured: true,  carriedBy: [] },
  // Social.
  POST:         { bucket: "MEMORIES", structured: false, carriedBy: ["post_card"] },
  MEMORY:       { bucket: "MEMORIES", structured: false, carriedBy: ["memory_card"] },
  MEMORY_NOTE:  { bucket: "MEMORIES", structured: false, carriedBy: [] },
});

/**
 * Subtypes with a bucket and NO shareable family behind them.
 *
 * `compass_card` is the whole list, and it is here rather than quietly folded
 * into `PLACE` because that would be a lie with the same shape as the defect
 * above. `shareAuthorizationPolicy.ts` declares it `sourceDomain: "compass"`,
 * "carries no private source object" — Compass is not one of §5's object
 * families and has no `LOADERS` entry, so there is no family whose preview,
 * state, actions and revocation this subtype's search behaviour could sit
 * beside. Declaring the exception keeps the derived map byte-identical to the
 * hand-written one it replaces AND leaves the gap visible: this is the one
 * searchable card kind that is not registered through the capability contract.
 */
export const FAMILYLESS_SUBTYPE_BUCKET: Readonly<Record<string, { bucket: TelegraphSearchBucket; structured: boolean; why: string }>> = dispatchTable({
  compass_card: {
    bucket: "PLACES",
    structured: true,
    why: "Compass answer card — sourceDomain 'compass', which is not a §5 object family and has no shareable loader.",
  },
});

/**
 * Which message `subtype` lands in which bucket — DERIVED from the family
 * registration above plus the declared exceptions.
 *
 * Subtypes are the ones actually written by this repository — found by reading
 * the writers, not by guessing: `routes/circle.ts` (`meeting_point`, `arrived`,
 * `meetup_confirmed`, `meetup_cancelled`, `hidden_gem`), `routes/messaging.ts`
 * (`discovery_card`, `post_card`, `event_context_card`), `routes/telegraph.ts`
 * (`compass_card`), the call subtypes, and `app/messages/[id].tsx` (`meetup`).
 *
 * A subtype claimed by two families would silently take whichever was written
 * last, so it throws at module load instead. That cannot happen by accident
 * from reading the table above; it can happen very easily from editing it.
 */
function deriveSubtypeBucket(): Readonly<Record<string, TelegraphSearchBucket>> {
  // Null-prototype accumulators, not `{}`: a family that declared a subtype
  // literally named `__proto__` would otherwise set no key at all on a literal
  // (the assignment reparents the object instead), so the duplicate-claim check
  // below would pass and the subtype would silently have no bucket.
  const out = Object.create(null) as Record<string, TelegraphSearchBucket>;
  const owner = Object.create(null) as Record<string, string>;
  for (const [family, reg] of Object.entries(SEARCH_BEHAVIOUR)) {
    for (const subtype of reg.carriedBy) {
      if (owner[subtype] !== undefined) {
        throw new Error(
          `conversationSearch: message subtype "${subtype}" is claimed by both ${owner[subtype]} and ${family}. ` +
            `One family must own it, or the bucket a hit lands in depends on object key order.`,
        );
      }
      owner[subtype] = family;
      out[subtype] = reg.bucket;
    }
  }
  for (const [subtype, entry] of Object.entries(FAMILYLESS_SUBTYPE_BUCKET)) {
    if (owner[subtype] !== undefined) {
      throw new Error(
        `conversationSearch: "${subtype}" is declared family-less and is also carried by ${owner[subtype]}.`,
      );
    }
    out[subtype] = entry.bucket;
  }
  return dispatchTable(out);
}

export const SUBTYPE_BUCKET: Readonly<Record<string, TelegraphSearchBucket>> = deriveSubtypeBucket();

/**
 * Structured kinds, for §21's last line. "Ask this conversation" prefers these
 * over prose, and this set is what "structured" means — not a vibe. Derived
 * from the same registration, so a family cannot be structured in one map and
 * not in the other.
 */
function deriveStructuredSubtypes(): ReadonlySet<string> {
  const out = new Set<string>();
  for (const reg of Object.values(SEARCH_BEHAVIOUR)) {
    if (reg.structured) for (const subtype of reg.carriedBy) out.add(subtype);
  }
  for (const [subtype, entry] of Object.entries(FAMILYLESS_SUBTYPE_BUCKET)) {
    if (entry.structured) out.add(subtype);
  }
  return out;
}

export const STRUCTURED_SUBTYPES: ReadonlySet<string> = deriveStructuredSubtypes();

/**
 * §606's sixth capability, for one object family. `null` means the family
 * registers no search behaviour — a hit on a message carrying it falls to
 * MESSAGES like any other prose, which is the safe direction and is now
 * something a caller can ASK about instead of having to know.
 */
export function searchBehaviourFor(objectType: string): TelegraphSearchBehaviour | null {
  return lookup(SEARCH_BEHAVIOUR, objectType);
}

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
  // `lookup`, not `SUBTYPE_BUCKET[subtype]`: `messages.subtype` is written
  // straight from the request body by `routes/messaging.ts`, so this key is
  // sender-controlled. See `contracts/dispatchTable.ts` — the table is
  // prototype-less, and this says out loud why that matters here.
  const mapped = lookup(SUBTYPE_BUCKET, subtype);
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
