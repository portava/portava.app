/**
 * Telegraph §2.1 — what the conversation list calls a §6.2 typed message.
 *
 * ── THE DEFECT THIS EXISTS TO CLOSE ─────────────────────────────────────────
 * Every §6.2 typed kind stores a validated JSON ENVELOPE in `messages.body`.
 * `TelegraphInboxScreen`'s preview resolver labelled the OLDER shared cards
 * (post_card, discovery_card, meetup …) and had no entry for any §6.2 kind, so
 * the last line of a conversation in which someone had sent a location, a GIF,
 * an announcement, a Memory Note, a safety check-in or a voice note was the
 * envelope itself:
 *
 *   {"kind":"VOICE","envelopeVersion":"1","payload":{"url":"post-media/…
 *
 * That is the exact failure the resolver's own header describes — "showing it
 * raw leaks `{"postId":"..."}` into the conversation list" — reappearing on a
 * newer set of kinds.
 *
 * ── WHY THESE ARE KEYED ON `msgType`, NOT ON `subtype` ──────────────────────
 * For a shared card, `subtype` IS the kind (`post_card`, `discovery_card`), and
 * the resolver has always read `subtype ?? msgType` for exactly that reason.
 * For a §6.2 typed kind `subtype` is a discriminator WITHIN the kind —
 * LOCATION's precision (`area`/`venue`/`exact`), GIF's provider (`giphy`),
 * ACTION's verb. Looking at `subtype` first finds `area` for a location
 * message, matches nothing, and falls through to the raw envelope.
 *
 * Worse, the two namespaces COLLIDE: `subtypeFor(ACTION)` in
 * `artifacts/api-server/src/services/telegraph/messageKinds.ts` writes the
 * action verb lower-cased into `subtype`, and `meetup` is a key of the shared
 * card table. Resolved in the wrong order, an ACTION proposing a meetup reads
 * as "Created a meetup" — stating that a meetup EXISTS, when §8.2 says an
 * ACTION message is a PROPOSAL until someone confirms it. So the typed lookup
 * runs FIRST, and that order is pinned by a test.
 *
 * ── WHY THIS IS A MODULE AND NOT TWENTY LINES IN THE SCREEN ─────────────────
 * census-telegraph cites `components/TelegraphInboxScreen.tsx` by LINE NUMBER
 * (:33, :222, :226, :457). Fifty-five lines inserted near the top of that file
 * silently repoints every one of them. Here it costs nothing and moves nothing.
 */

/** §6.2's typed kinds, keyed on `msgType`. */
export const TYPED_KIND_LABELS: Record<string, string> = {
  voice: 'Voice message',
  location: 'Shared a location',
  gif: 'GIF',
  media_album: 'Shared photos',
  announcement: 'Announcement',
  memory_note: 'Memory Note',
  action: 'Suggested a plan',
  portava_object: 'Shared a Portava item',
};

/**
 * SAFETY is labelled from its `subtype` rather than generically, because the
 * four classes are not interchangeable in a list: "Asked for help" and "All
 * clear" are the reason someone looks at their inbox, and collapsing them into
 * "Safety update" would hide the one that matters behind the one that does not.
 */
export const SAFETY_SUBTYPE_LABELS: Record<string, string> = {
  check_in: 'Checked in',
  heads_up: 'Heads up',
  need_help: 'Asked for help',
  all_clear: 'All clear',
};

/**
 * The label for a §6.2 typed message, or null when this is not one — in which
 * case the caller falls through to the shared-card table and then to the body.
 *
 * `media` deliberately has NO entry: a photo's caption is better than the word
 * "Photo", and an empty caption is an honest empty preview.
 */
export function typedKindPreviewLabel(
  msgType: string | null | undefined,
  subtype: string | null | undefined,
): string | null {
  if (msgType === 'safety') {
    return (subtype ? SAFETY_SUBTYPE_LABELS[subtype] : undefined) ?? 'Safety update';
  }
  return (msgType ? TYPED_KIND_LABELS[msgType] : undefined) ?? null;
}
