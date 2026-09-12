/**
 * checkTripPushPolicy — a trip push that skips the attention policy is counted.
 *
 * ── THE MEASUREMENT ──────────────────────────────────────────────────────────
 * census-trips TR200 ("Trip events must pass an attention policy") read C with:
 *
 *   "They do: NotificationRouter consults NotificationPreferenceService,
 *    NotificationDeduplicationService and CompassNotificationEngine
 *    .evaluateNotification before dispatching"
 *
 * The router does all three. Measured 2026-09-11: **ten trip push sites do not
 * go through it.** They call `sendPushWithRetry` directly, and that function is
 * a pure transport wrapper — it filters malformed tokens, retries transient
 * Expo failures and clears dead tokens. It consults no preference, no dedup and
 * no digest. One site says so in a comment: "notifRouter.route() is
 * intentionally NOT called here; push was already sent above via
 * sendPushWithRetry to avoid double-delivery." The bypass is deliberate, which
 * is why it needs counting rather than fixing in passing.
 *
 * TR200 moved C -> W on this.
 *
 * ── WHY IT MATTERS, CONCRETELY ───────────────────────────────────────────────
 * NotificationPreferenceService is not decorative: it holds per-user channel
 * preferences, per-category preferences, and quiet hours (it computes
 * `localMinutesOfDay` against the user's timezone). A user who has switched a
 * category off, or who is inside their quiet hours, still receives all ten of
 * these pushes.
 *
 * ── WHAT THIS IS ─────────────────────────────────────────────────────────────
 * A shrink-only ratchet, not a fix. Re-plumbing delivery through the router is a
 * design change with a real hazard the code already names — double-delivery —
 * and it belongs to whoever owns notifications. This stops an eleventh appearing
 * and makes the ten impossible to forget.
 *
 * Run: node --import tsx/esm src/scripts/checkTripPushPolicy.ts
 */
import { readFileSync } from "node:fs";

const SRC = new URL("../", import.meta.url).pathname.replace(/\/$/, "");

/** Trip-owned surfaces that may dispatch a notification. */
const FILES = [
  "routes/trips.ts",
  "routes/trips-expansion.ts",
  "lib/tripReminderScheduler.ts",
];

/** Direct dispatch: the transport wrapper, called without the router. */
const DIRECT_PUSH = /\bsendPushWithRetry\s*\(/;

/**
 * KNOWN BYPASSES, 2026-09-11 — ten sites, as `file:line`. Shrink-only: route one
 * through NotificationRouter and delete its entry. An entry that has stopped
 * being true goes on excusing the next one, which is what the four RLS
 * allowlists emptied on this branch had been doing for months.
 *
 * Line numbers are deliberate. A count alone would let a site move and a new one
 * appear with the total unchanged — the check would stay green across a
 * substitution, which is the failure mode a bare number always has.
 */
const KNOWN_BYPASSES = new Set<string>([
  // EMPTY since 2026-09-12 (census-trips §42, TR200 back to C): the ten sites
  // this list carried — four in routes/trips.ts, five in routes/trips-expansion.ts,
  // one in lib/tripReminderScheduler.ts — now call sendTripPush (lib/tripPush.ts),
  // which decides §11.4's attention level per recipient and is the ONE place
  // that still calls sendPushWithRetry. The list stays shrink-only: a new
  // direct call in FILES is a failure here, not an entry.
]);

// "Zero bypasses" is only a clean result if the dispatch still exists somewhere
// and that somewhere is the router. The router file must contain exactly one
// direct call; zero means the call was renamed and this check is verifying
// nothing, more than one means a second dispatch path grew inside the router.
const ROUTER = "lib/tripPush.ts";
const routerCalls = readFileSync(`${SRC}/${ROUTER}`, "utf8").split("\n").filter((line) => {
  const t = line.trimStart();
  return !t.startsWith("*") && !t.startsWith("//") && !line.includes("import") && DIRECT_PUSH.test(line);
}).length;

const found = new Set<string>();
for (const rel of FILES) {
  readFileSync(`${SRC}/${rel}`, "utf8").split("\n").forEach((line, i) => {
    if (line.trimStart().startsWith("*") || line.trimStart().startsWith("//")) return;
    if (line.includes("import")) return;
    if (DIRECT_PUSH.test(line)) found.add(`${rel}:${i + 1}`);
  });
}

const problems: string[] = [];

// A pattern that matches nothing looks exactly like a tree with no bypasses:
// the router's own dispatch is the proof that the pattern still matches.
if (routerCalls !== 1) {
  problems.push(
    `::error::checkTripPushPolicy expected exactly ONE direct sendPushWithRetry call in ${ROUTER} (the router's dispatch) and found ${routerCalls}. ` +
      "Zero means the call was renamed and this check is verifying nothing; more than one means a second dispatch path grew inside the router. " +
      "An empty result is not a clean result.",
  );
}

for (const site of found) {
  if (!KNOWN_BYPASSES.has(site)) {
    problems.push(
      `::error::${site} dispatches a push via sendPushWithRetry without NotificationRouter, and is not a ` +
        `known bypass. That skips per-user channel preferences, per-category preferences and quiet hours. ` +
        `Route it through NotificationRouter, or — if a line simply moved — update KNOWN_BYPASSES in the ` +
        `same commit that moved it, so the list stays a statement about sites rather than a total.`,
    );
  }
}
for (const site of KNOWN_BYPASSES) {
  if (!found.has(site)) {
    problems.push(
      `::error::KNOWN_BYPASSES lists ${site}, which no longer dispatches a push there. If it was routed ` +
        `through NotificationRouter, DELETE the entry. If the line merely moved, update it. Leaving a ` +
        `stale entry lets the next real bypass hide behind an unchanged count.`,
    );
  }
}

for (const p of problems) console.error(p);
console.log(
  `check:trip-push-policy — ${found.size} trip push site(s) bypass NotificationRouter ` +
    `(baseline ${KNOWN_BYPASSES.size}) across ${FILES.length} file(s).`,
);
console.log(
  "NOTE: DOES NOT COVER — whether the router itself applies the policy correctly, or pushes dispatched " +
    "from non-trip surfaces. It counts the trip-side bypasses census-trips TR200 is graded on.",
);
if (problems.length > 0) { console.error(`\n${problems.length} problem(s) found.`); process.exit(1); }
console.log("\ncheck:trip-push-policy PASSED");
