/**
 * Telegraph §24 — the six projections, as data.
 *
 * §24 names six projections and one rule: "Mobile clients consume server-built
 * projections instead of independently joining raw tables and reimplementing
 * authorization/business logic." The census found two of the six built, four
 * absent, and the rule broken in exactly two places on the conversation screen.
 * RE-MEASURED 2026-10-05 (lane T2): all six are served — two built, four
 * partial with the gap stated — and the client bypass list is empty.
 * `src/test/telegraphProjectionRegistryHonesty.test.ts` probes the tree for each
 * projection's route independently of this file, so `absent` beside a mounted
 * route, or `built` beside a missing one, is a failing test.
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
  /**
   * The route a client reads it through, as "<route module> <METHOD> <path>",
   * or null when nothing serves it. A projection nobody can read is not built.
   */
  readonly servedAt: string | null;
  readonly note: string;
}

export const TELEGRAPH_PROJECTIONS: readonly TelegraphProjection[] = [
  {
    id: "PRJ-01",
    name: "TelegraphHomeProjection",
    censusRow: "T289",
    status: "partial",
    builtBy: "src/routes/messaging.ts",
    servedAt: "src/routes/messaging.ts GET /me/threads",
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
    servedAt: "src/routes/messaging.ts GET /threads/:threadId/messages",
    note:
      "GET /threads/:id/messages sanitizes sender identities per viewer, joins " +
      "per-recipient translations, resolves reply context and enriches mention " +
      "spans — and it now BOUNDS history to the caller's window when the §14.3 " +
      "flag is on. It now also carries §24's second clause, 'renderable ordered " +
      "thread WITH CURRENT PERMISSIONS': a `permissions` block holding §14.1's " +
      "ten ConversationCapabilities, their per-capability reasons, which of the " +
      "eight inputs were read, and `degraded` when one of them could not be. " +
      "The block is ASKED of `resolveConversationCapabilities` rather than " +
      "re-derived, so the projection cannot disagree with the gate, and it " +
      "gates nothing itself — CAPABILITY_ENFORCEMENT_SITES names where each " +
      "refusal actually happens. `partial` and not `built` for one remaining " +
      "reason: history is bounded only while telegraph_history_bound_enabled " +
      "is TRUE, and that flag is seeded FALSE in every database (T211).",
  },
  {
    id: "PRJ-03",
    name: "SharedContextProjection",
    censusRow: "T291",
    status: "built",
    builtBy: "src/services/telegraph/sharedContext.ts",
    servedAt: "src/routes/telegraphSharedContext.ts GET /threads/:threadId/shared-context",
    note:
      "§3.4's TelegraphSharedContextProjection — conversationId, generatedAt and the " +
      "now / upcoming / unresolved / past arrays — built by buildSharedContextProjection " +
      "from canonical mutuality sources only (trip_members, meetup_invites, " +
      "event_attendees, rent_buddy_bookings, collection_items; never the message " +
      "table, §3.2), ordered by §3.3, Want-to-Do in `unresolved`, each item carrying " +
      "its available actions. A rail built on a failed read says `incomplete` rather " +
      "than rendering empty. The client renders it (SharedContextRail) and computes " +
      "none of it. RE-GRADED 2026-10-05 (lane T2): this entry said `absent` after " +
      "census T13-T21 had moved to C; the Passport SharedContextService it used to " +
      "point at is a different programme's profile-pair projection.",
  },
  {
    id: "PRJ-04",
    name: "NearbyAvailableProjection",
    censusRow: "T292",
    status: "partial",
    builtBy: "src/services/telegraph/reachablePeople.ts",
    servedAt: "src/routes/nearbyReachable.ts GET /nearby/reachable",
    note:
      "§30A.2's ReachablePersonProjection: relationship (projected from canMessage's " +
      "context), availability (audience policy + quick status), proximity as a bucket " +
      "only, shared context, privacy and safety, ranked without disclosing distance; " +
      "candidates are the social graph, never a viewport. `partial`, not `built`, for " +
      "two stated reasons: the route answers nobody while nearby_reachable_enabled is " +
      "FALSE (seeded FALSE by 2990), and `safety` is a constant rather than a read " +
      "(census T382). 'Open opportunities' have no source on this surface.",
  },
  {
    id: "PRJ-05",
    name: "CoordinationProjection",
    censusRow: "T293",
    status: "partial",
    builtBy: "src/services/telegraph/coordination.ts",
    servedAt: "src/routes/telegraphCoordination.ts GET /threads/:threadId/coordination",
    note:
      "§24's 'meeting, attendance, ETA/status and safety-relevant operational state': " +
      "the coordination session (projectCoordinationSession, census T85), §9's derived " +
      "state for the plan being coordinated, the latest USER-DECLARED quick state per " +
      "member with arrival counts, the rendezvous, decisions and commitments — served " +
      "per thread — and the safety-relevant state from GET /threads/:threadId/safety-mode " +
      "in the same route module. `partial` for one stated reason: ETA is only what a " +
      "member declares (ON_MY_WAY / RUNNING_LATE); there is no system-derived ETA " +
      "(census T27, T1's range), and §9.1 forbids presenting the one as the other.",
  },
  {
    id: "PRJ-06",
    name: "ConversationContentIndex",
    censusRow: "T294",
    status: "partial",
    builtBy: "src/routes/telegraphKinds.ts",
    servedAt: "src/routes/telegraphKinds.ts GET /threads/:threadId/drawer",
    note:
      "The content drawer. CORRECTED 2026-10-03: the earlier note said \"dead-coded " +
      "behind a literal false (T66)\" and that is no longer true. `GET /threads/:threadId/" +
      "drawer` serves it (`routes/telegraphKinds.ts:376`), membership-gated before any read " +
      "(`:393`), and the client mounts the entry point in the thread header " +
      "(`travel-buddy-standalone/app/messages/[id].tsx:1918`, testID " +
      "`telegraph-open-content-drawer`) with the sheet rendered at `:2376`. NOT " +
      "unconditional, and not a flag either: the mount sits inside the `{!compact && …}` " +
      "header-actions block (`[id].tsx:1892`), a layout variant, so the compact header " +
      "offers no way in. THE GAP THAT KEEPS THIS `partial` RATHER THAN `built`: §24 asks " +
      "for a server-BUILT projection, and this is an on-demand route that classifies the " +
      "thread's rows per request and stores nothing — there is no materialised " +
      "ConversationContentIndex, so nothing can be read without re-deriving it, and nothing " +
      "outside a live request can consume it. The census verdict row (T294) still carries " +
      "the old wording; re-grading it is the lead's call, not this registry's. " +
      "RE-GRADED 2026-10-06 on the lead's ruling: T294 is W (census-telegraph §45e). " +
      "Lane T2 had moved this entry to `built` on 2026-10-05; main's `partial` stands.",
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
  // EMPTY since 2026-10-05 (lane T2, census T295). The last three — a member
  // count and the "accepted member" gate on message_thread_members, and is_e2ee
  // on message_threads, all on app/messages/[id].tsx — were replaced by
  // GET /threads/:id/capabilities: the gate is the server's canSendMessage and
  // the two facts are server/telegraph/conversationFacts.ts. The receipt reads
  // went on 2026-10-03 (GET /threads/:id/receipts via useThreadReadState).
  // check:telegraph-slos re-derives this list from the client tree on every run.
];
