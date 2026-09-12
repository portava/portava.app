/**
 * Telegraph §24 — the six projections, as data.
 *
 * §24 names six projections and one rule: "Mobile clients consume server-built
 * projections instead of independently joining raw tables and reimplementing
 * authorization/business logic." The census found two of the six built, four
 * absent, and the rule broken in exactly two places on the conversation screen.
 *
 * WHY THIS REGISTRY EXISTS RATHER THAN A COMMENT
 * ----------------------------------------------
 * Because the rule is the kind that decays silently. A projection that exists
 * today can be bypassed tomorrow by one convenient PostgREST call from a screen,
 * and nothing in a codebase notices a new client-side join. `src/scripts/
 * checkTelegraphProjections.ts` reads this registry and re-derives the
 * BYPASSES — direct client reads of a messaging table — on every run, failing
 * when the count grows. The two known ones are pinned, so they can be removed
 * but not multiplied.
 *
 * The registry is also what the §30A.17 diagnostics surface lists, so an
 * operator asking "which projections exist" gets an answer that cannot drift
 * from the one this checker enforces.
 */

export type ProjectionStatus =
  /** Built server-side, consumed by the client through the API. */
  | "built"
  /** Built, and missing a part the spec names. The gap must be in the note. */
  | "partial"
  /** Does not exist. */
  | "absent";

export interface TelegraphProjection {
  readonly id: string;
  /** The spec's own name for it. */
  readonly name: string;
  readonly censusRow: string;
  readonly status: ProjectionStatus;
  /** Repo-relative module that builds it, or null when nothing does. */
  readonly builtBy: string | null;
  readonly note: string;
}

export const TELEGRAPH_PROJECTIONS: readonly TelegraphProjection[] = [
  {
    id: "PRJ-01",
    name: "TelegraphHomeProjection",
    censusRow: "T289",
    status: "partial",
    builtBy: "src/routes/messaging.ts",
    note:
      "GET /me/threads is a real server-built projection: it resolves the other " +
      "participant's display identity under the name-visibility rule, folds in " +
      "unread counts and thread type, and the client never joins any of it. What " +
      "the spec asks for and it does not have is the Now band and the nearby " +
      "summary — neither has a source (T8, T292).",
  },
  {
    id: "PRJ-02",
    name: "ConversationProjection",
    censusRow: "T290",
    status: "partial",
    builtBy: "src/routes/messaging.ts",
    note:
      "GET /threads/:id/messages sanitizes sender identities per viewer, joins " +
      "per-recipient translations, resolves reply context and enriches mention " +
      "spans — and it now BOUNDS history to the caller's window when the §14.3 " +
      "flag is on. It still carries no permissions block, which is the half §24 " +
      "names explicitly: 'renderable ordered thread WITH CURRENT PERMISSIONS'. " +
      "That block is §14.1's ConversationCapabilities (T207) and does not exist.",
  },
  {
    id: "PRJ-03",
    name: "SharedContextProjection",
    censusRow: "T291",
    status: "absent",
    builtBy: null,
    note:
      "Does not exist. The nearest artifact belongs to a different programme: " +
      "Passport's SharedContextService builds explainable facts for a PROFILE " +
      "PAIR under its own spec's §17/§18, is consumed only by the passport route, " +
      "and has no conversation id, no now/upcoming/unresolved/past arrays and no " +
      "available actions.",
  },
  {
    id: "PRJ-04",
    name: "NearbyAvailableProjection",
    censusRow: "T292",
    status: "absent",
    builtBy: null,
    note:
      "Does not exist, and neither does its input: Telegraph never reads " +
      "availability at all, and there is no proximity surface to rank over.",
  },
  {
    id: "PRJ-05",
    name: "CoordinationProjection",
    censusRow: "T293",
    status: "absent",
    builtBy: null,
    note:
      "Does not exist. Coordination sessions do not exist (T85); meetups, " +
      "meeting points and temporary location each exist separately and none is " +
      "conversation-scoped.",
  },
  {
    id: "PRJ-06",
    name: "ConversationContentIndex",
    censusRow: "T294",
    status: "absent",
    builtBy: null,
    note:
      "The content drawer. Dead-coded behind a literal false (T66) — which is " +
      "worse than absent for a reader, because the affordance looks built.",
  },
];

/**
 * Direct client reads of a raw messaging table — every one a violation of §24's
 * closing rule, each pinned so it can be removed but not multiplied.
 *
 * These are not "technical debt" in the abstract: the second one RECOMPUTES AN
 * AUTHORIZATION DECISION on the client, which is the shape §29's "no hidden
 * client-side authorization replacing server policy" forbids. It replaces
 * nothing today — every route re-derives authorization server-side and ignores
 * the client entirely — so it is an affordance gate rather than a hole. It is
 * still the wrong place for the decision to be computed, and a future screen
 * that trusted it would not be adding the bug, it would be inheriting it.
 */
export interface ProjectionBypass {
  /** Repo-relative client file. */
  readonly file: string;
  /** The raw table it reads. */
  readonly table: string;
  readonly censusRow: string;
  readonly note: string;
}

export const TELEGRAPH_PROJECTION_BYPASSES: readonly ProjectionBypass[] = [
  {
    file: "travel-buddy-standalone/app/messages/[id].tsx",
    table: "message_thread_members",
    censusRow: "T295",
    note:
      "FOUR reads, not the two the census recorded — re-derived by enumeration " +
      "rather than by reading the screen top to bottom. (1) the other party's " +
      "last_read_at for DM read receipts; (2) a member count; (3) the 'permission " +
      "gate: accepted thread members only', whose result decides what the screen " +
      "offers; (4) the group roster plus their last_read_at, for group receipts. " +
      "All four belong behind the ConversationProjection's missing permissions " +
      "block (PRJ-02); (3) is the one that recomputes an authorization decision.",
  },
  {
    file: "travel-buddy-standalone/app/messages/[id].tsx",
    table: "message_threads",
    censusRow: "T295",
    note:
      "Reads is_e2ee directly off the thread row to decide whether the composer " +
      "encrypts. The SERVER makes the same decision independently on every send " +
      "and refuses a plaintext body in an E2EE thread, so the client read is an " +
      "affordance and not the gate — but it is a second copy of a decision the " +
      "projection should carry.",
  },
  {
    file: "travel-buddy-standalone/src/components/GroupChatScreen.tsx",
    table: "message_thread_members",
    censusRow: "T295",
    note:
      "The group screen reads the roster and every member's last_read_at to build " +
      "read receipts client-side. Not in the census's count, and the same class: " +
      "a receipt projection the server does not build, so the client joins the " +
      "raw table to build it.",
  },
];
