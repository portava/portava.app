/**
 * reportReasons — ONE report vocabulary, and the intent classifier that keeps a
 * viewer preference out of the moderation queue.
 *
 * ── WHY THIS FILE EXISTS ─────────────────────────────────────────────────────
 * `POST /api/reports` (routes/reports.ts) defines the platform's report
 * contract: eight reason codes, a severity derived from three of them, a rate
 * limit, and an evidence-preserving `reports` row that is never deleted.
 *
 * `POST /api/media/:id/report` (routes/mediaFeed.ts) documented itself as "the
 * same pipeline as reports.ts" and was not. It accepted
 * `z.string().max(100).default("spam")` — ANY string, and a MISSING reason
 * became a spam report — computed no severity, applied no rate limit, and wrote
 * straight into the same `reports` table.
 *
 * That mattered because of what the shipped client sends it. The Media tab's
 * options sheet (travel-buddy-standalone/src/components/media/MediaMoreMenu.tsx)
 * shows a non-owner "Not interested" and "Hide" as its FIRST TWO rows, above
 * "Report", on both reachable surfaces — WatchFeed (the default mode) and
 * GemsFeed. Both call the report endpoint:
 *
 *   Not interested → hideMedia(id)            → { reason: 'not_interested' }
 *   Hide           → reportMedia(id, ...)     → { reason: 'hide_from_feed' }
 *
 * So on a post, a viewer expressing disinterest filed a permanent moderation
 * report against another user's content with `reason_code = 'not_interested'`;
 * on a gem, it inserted a `hidden_gem_reports` row and incremented
 * `hidden_gems.report_count` — the exact "a pile of reports is evidence someone
 * should look" signal HiddenGemModerationService is written to protect from
 * weaponisation.
 *
 * AND IT HID NOTHING, THOUGH THE HIDE WAS ALREADY BUILT. `POST /api/posts/
 * :postId/hide` (routes/posts.ts) writes `post_hides`; the following feed, the
 * global feed and Pulse all read it; `services/posts.ts hidePost` calls it from
 * the Pulse feed card; `src/test/postHide.test.ts` covers it. The same gesture
 * worked on a Pulse card and did not work on the Media tab. That is worse than
 * an unbuilt feature: it is a divergent duplicate of a working one, pointed at
 * the moderation queue. Both routes now write through lib/postHide.
 *
 * ── THE THREE INTENTS ────────────────────────────────────────────────────────
 * A reason string arriving at a media surface is one of three things, and they
 * must not share a destination:
 *
 *   PREFERENCE           this viewer does not want to see this item.
 *                        Destination: the viewer's own hide list. Never a report.
 *   ABUSE                a moderation claim about the content.
 *                        Destination: the real report pipeline, with severity.
 *   GEM_PLACE_MISMATCH   'media_does_not_match_place' — a gem-only accuracy
 *                        claim with no meaning on a post.
 *
 * Anything else is UNKNOWN and is REFUSED rather than defaulted. Defaulting was
 * the fail-open: it turned "the client sent a field we do not understand" into
 * "file a spam report".
 *
 * ── WHY THE VOCABULARY LIVES HERE AND NOT IN routes/reports.ts ───────────────
 * Two routes writing the same table from two private copies of a list is how
 * they drifted in the first place. Both now import this one.
 */

/**
 * The eight reason codes `reports.reason_code` is written with. This is the
 * whole vocabulary — a code outside it is not a report.
 */
export const REPORT_REASON_CODES = [
  "harassment",
  "spam",
  "hate_speech",
  "violence",
  "impersonation",
  "nudity",
  "misinformation",
  "other",
] as const;

export type ReportReasonCode = (typeof REPORT_REASON_CODES)[number];

/**
 * The three codes that make a report high-severity. `routes/reports.ts` turns
 * high severity on a person-target into an auto-restrict plus a 90-day
 * anti-retaliation cooldown, so a path that writes `reports` without computing
 * this leaves the reporter unprotected by omission.
 */
export const HIGH_SEVERITY_REPORT_CODES: ReadonlySet<string> = new Set([
  "harassment",
  "hate_speech",
  "violence",
]);

/**
 * Reasons that are a VIEWER PREFERENCE, not an accusation. These are the two
 * the Media options sheet sends from its "Not interested" and "Hide" rows.
 */
export const VIEWER_PREFERENCE_REASONS: ReadonlySet<string> = new Set([
  "not_interested",
  "hide_from_feed",
]);

/**
 * Gem-only accuracy claim. Meaningless on a post: there is no place to mismatch.
 */
export const GEM_PLACE_MISMATCH_REASON = "media_does_not_match_place";

export type MediaReportIntent =
  | "preference"
  | "abuse"
  | "gem_place_mismatch"
  | "unknown";

/**
 * Classify what a media-surface `reason` string is asking for.
 *
 * FAIL-CLOSED. An unrecognised string is `unknown`, and the caller must refuse
 * it. It must never fall through to a report: the endpoint's old
 * `.default("spam")` is precisely the shape of bug this returns `unknown` to
 * prevent.
 */
export function classifyMediaReportReason(reason: string): MediaReportIntent {
  const r = reason.trim();
  if (VIEWER_PREFERENCE_REASONS.has(r)) return "preference";
  if (r === GEM_PLACE_MISMATCH_REASON) return "gem_place_mismatch";
  if ((REPORT_REASON_CODES as readonly string[]).includes(r)) return "abuse";
  return "unknown";
}

/** The severity a report with this reason code carries. */
export function reportSeverityFor(reasonCode: string): "high" | "normal" {
  return HIGH_SEVERITY_REPORT_CODES.has(reasonCode) ? "high" : "normal";
}
