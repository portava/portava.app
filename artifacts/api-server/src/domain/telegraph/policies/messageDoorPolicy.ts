/**
 * Telegraph — what a door into `public.messages` must hold, and which doors exist.
 *
 * `lib/telegraphThreadWrite.ts` states the rule in its first paragraph: "A second
 * write endpoint that skipped one of them would be a weaker door into the same
 * table." This module is that rule made checkable. It is PURE — no imports — so
 * the suite that reads it (`test/telegraphMessageDoors.test.ts`) runs without a
 * database, a server or a package install.
 *
 * THREE THINGS WERE WRONG, each verified against the tree at `f71cfb85f`:
 *
 * 1. THE TEXT DOOR LET THE CLIENT PICK THE RENDERER. `POST /threads/:id/messages`
 *    collapsed `msgType` to `system` or `text` and then stored whatever `subtype`
 *    the request named. The thread screen draws a `system` row as PLATFORM chrome,
 *    with no sender attribution: `call_*` as a call-history line with a call-back
 *    button, `rent_buddy_*` as a booking milestone banner, and anything it does not
 *    recognise as a centred notice carrying the body verbatim. So any member of a
 *    thread could post "Payment received", a missed call, or a notice in the
 *    platform's voice. `shareAuthorizationPolicy.ts` recorded the seam as
 *    "UNBOUNDED, AND THIS IS THE FINDING" and called it a rendering-shape hole; a
 *    message a recipient cannot tell from one the platform wrote is a safety hole.
 *
 * 2. THE BURST LIMIT GUARDED ONE DOOR OF SEVEN. §22's adaptive send limit
 *    (`sendRateLimit.ts`, census T279) was called from the text door only. Its own
 *    header says what it is for — "a compromised account fanning a scam across a
 *    hundred threads, a script" — and a script does not care which door it uses:
 *    media, typed kinds, voice, share and coordination were all unlimited.
 *
 * 3. THE COMMAND DOOR WROTE WITH A MEMBERSHIP CHECK AND NOTHING ELSE.
 *    `CREATE_COORDINATION_SESSION` on `POST /telegraph/commands` inserts a
 *    `messages` row carrying a free-text title and note. It skipped the
 *    `disable_messaging` stop, the 1:1 block guard and the E2EE refusal — so a
 *    blocked sender could still write into a thread with the person who blocked
 *    them, and the server would store plaintext in an end-to-end encrypted one.
 *    `ADD_REACTION` skipped the same three.
 */

/* ───────────────────────── 1. the client's discriminator ───────────────────────── */

/**
 * The `system` subtypes the APP ITSELF authors through the text door.
 *
 * A closed list, and each entry is checked against the client tree by the suite:
 * an entry no client file writes is refused there as stale, and a `system`
 * subtype a client file sends that is not listed here fails the same suite. That
 * is what stops this list drifting into either a block on a real feature or a
 * door left open for a retired one.
 *
 *   discovery_card  components/DiscoveryShareSheet.tsx, services/messaging.ts
 *   post_card       components/ShareSheet.tsx
 *   compass_card    app/messages/[id].tsx
 *   meetup          app/messages/[id].tsx (an unscoped meetup card)
 *   e2ee_welcome    lib/e2ee — the MLS Welcome, sent while the thread is plaintext
 *
 * EVERYTHING ELSE IS THE SERVER'S. `call_*`, `rent_buddy_*`, `meetup_confirmed`,
 * `event_context_card` and the rest are written by server code that has just
 * performed the thing the row announces. A client naming one is announcing
 * something that did not happen.
 */
export const CLIENT_SYSTEM_SUBTYPES = [
  "discovery_card",
  "post_card",
  "compass_card",
  "meetup",
  "e2ee_welcome",
] as const;
export type ClientSystemSubtype = (typeof CLIENT_SYSTEM_SUBTYPES)[number];

export type ClientDiscriminatorRefusal =
  | "system_subtype_required"
  | "system_subtype_not_client_sendable"
  | "text_carries_no_subtype";

export type ClientDiscriminator =
  | { ok: true; msgType: "text" | "system"; subtype: ClientSystemSubtype | null }
  | { ok: false; reason: ClientDiscriminatorRefusal; message: string };

/**
 * Decide the stored `msg_type` / `subtype` for a message arriving on the text door.
 *
 * REFUSES rather than rewrites. Quietly storing a forged `system` row as `text`
 * would turn a refusal into a different message than the one the caller asked to
 * send, and quietly dropping the subtype would let a caller believe it had been
 * accepted — the same reason `server/telegraph/commandRoute.ts` refuses a body
 * that names an actor instead of ignoring it.
 *
 * The refusal never echoes the supplied value: it is attacker-chosen text.
 */
export function resolveClientDiscriminator(msgTypeRaw: unknown, subtypeRaw: unknown): ClientDiscriminator {
  // Unchanged from the route this replaces: anything that is not exactly
  // `system` is an ordinary message. A client cannot select any other msg_type.
  const kind: "text" | "system" = msgTypeRaw === "system" ? "system" : "text";
  const named = typeof subtypeRaw === "string" ? subtypeRaw.trim() : "";

  if (kind === "system") {
    if (named.length === 0) {
      // The worst of the three shapes: a `system` row with no subtype is drawn
      // as a centred notice with the body as its text.
      return {
        ok: false,
        reason: "system_subtype_required",
        message: "A system message must name what it is. Send it as an ordinary message instead.",
      };
    }
    if (!(CLIENT_SYSTEM_SUBTYPES as readonly string[]).includes(named)) {
      return {
        ok: false,
        reason: "system_subtype_not_client_sendable",
        message: "That kind of system message is written by Portava, not sent from the app.",
      };
    }
    return { ok: true, msgType: "system", subtype: named as ClientSystemSubtype };
  }

  if (named.length > 0) {
    return {
      ok: false,
      reason: "text_carries_no_subtype",
      message: "An ordinary message does not carry a subtype.",
    };
  }
  return { ok: true, msgType: "text", subtype: null };
}

/* ───────────────────────────── 2. the send buckets ───────────────────────────── */

/**
 * Which burst bucket a send is counted in.
 *
 * ONE bucket for every ordinary door, deliberately. A bucket per door would give
 * a script seven times the allowance by rotating doors — the defect, restated as
 * a feature.
 *
 * `safety` is the single exception and it is a CONSERVATIVE DEFAULT, NOT A
 * DECISION. A §6.2 SAFETY message ("I need help", "home safe") is the one send a
 * burst limit must not pause because its sender argued for ten minutes first; it
 * is also a send a script could abuse if it were unlimited. So it gets its own
 * bucket at the same tier limit: never starved by ordinary traffic, never
 * unbounded. Whether a safety message may be paused at all is a safety-threshold
 * question for the owner, and both answers are one line here — map SAFETY to
 * `ordinary`, or give `safety` a different limit in `sendRateLimit.ts`.
 */
export type SendBucket = "ordinary" | "safety";

export const SEND_BUCKETS: readonly SendBucket[] = ["ordinary", "safety"];

/** The bucket for a §6.2 typed kind. Unknown kinds are ordinary: fail toward the limit. */
export function sendBucketForKind(kind: unknown): SendBucket {
  return kind === "SAFETY" ? "safety" : "ordinary";
}

/**
 * The limiter id for a (bucket, tier) pair.
 *
 * `ordinary` keeps the id the text door has used since the limiter was written
 * (`telegraph_send:<tier>`), so the doors that join it share the text door's
 * existing bucket rather than starting a second one beside it.
 */
export function sendLimiterId(bucket: SendBucket, tier: string): string {
  return bucket === "safety" ? `telegraph_send_safety:${tier}` : `telegraph_send:${tier}`;
}

/* ───────────────────────────── 3. the door registry ───────────────────────────── */

/**
 * The five gates, in the words `lib/telegraphThreadWrite.ts` uses for them.
 *
 *   stop        `disable_messaging`, fail-closed on an unreadable or absent read
 *   membership  ACTIVE membership (`left_at IS NULL`)
 *   block       the 1:1 block guard, fail-closed on an unreadable roster
 *   e2ee        an E2EE thread never receives server-readable plaintext
 *   rate        §22's adaptive burst limit
 */
export type DoorGate = "stop" | "membership" | "block" | "e2ee" | "rate";
export const DOOR_GATES: readonly DoorGate[] = ["stop", "membership", "block", "e2ee", "rate"];

export type MessageWriterClass =
  /** A person chose to put this row in this thread. All five gates apply. */
  | "user_door"
  /**
   * Server code announcing something it has just done (a call ended, a booking
   * moved, a meetup was confirmed). The actor did not choose the words, and the
   * gate that matters is the one on the operation being announced.
   */
  | "system_writer"
  /** Not a send: deletion, seeding, translation bookkeeping. */
  | "maintenance";

export interface MessageWriterDeclaration {
  /** Path under `artifacts/api-server/src/`. */
  readonly file: string;
  readonly writer: MessageWriterClass;
  /**
   * How a `user_door` holds the gates.
   *   shared  it calls `guardTelegraphThreadWrite`
   *   inline  it carries its own copy of each gate (the two original doors in
   *           `routes/messaging.ts`, which the shared guard was extracted FROM)
   */
  readonly guard?: "shared" | "inline";
  /**
   * Gates a `user_door` is KNOWN not to hold. Listed rather than hidden: an
   * inventory that only names the doors it has fixed reads as complete while
   * missing the ones that matter. Each entry is work for the lane named in
   * `owner`, and `KNOWN_WEAK_DOOR_CEILING` may only fall.
   */
  readonly missing?: readonly DoorGate[];
  readonly owner: string;
  readonly note: string;
}

/**
 * Every non-test file under routes/, server/, services/, lib/ and compass/ that
 * inserts into `public.messages`. The suite re-derives this list from the tree:
 * an undeclared writer fails it, and so does a declaration whose file no longer
 * writes.
 */
export const MESSAGE_WRITERS: readonly MessageWriterDeclaration[] = [
  // ── user doors that hold all five gates ────────────────────────────────────
  {
    file: "routes/messaging.ts",
    writer: "user_door",
    guard: "inline",
    owner: "telegraph",
    note:
      "POST /threads/:id/messages and POST /threads/:id/media. The shared guard was extracted from these two; " +
      "they keep their own copies because the text door also accepts ciphertext, which the shared guard refuses. " +
      "Also the request-accept preview insert, which re-states a message the request already carried.",
  },
  {
    file: "routes/telegraphKinds.ts",
    writer: "user_door",
    guard: "shared",
    owner: "telegraph",
    note: "POST /threads/:id/typed-messages. SAFETY is counted in its own bucket (sendBucketForKind).",
  },
  {
    file: "routes/telegraphVoice.ts",
    writer: "user_door",
    guard: "shared",
    owner: "telegraph",
    note: "POST /threads/:id/voice.",
  },
  {
    file: "routes/telegraphShare.ts",
    writer: "user_door",
    guard: "shared",
    owner: "telegraph",
    note: "POST /threads/:id/share.",
  },
  {
    file: "routes/telegraphCoordination.ts",
    writer: "user_door",
    guard: "shared",
    owner: "telegraph",
    note: "POST /threads/:id/coordination — decisions, votes, statuses, acknowledgements, sessions.",
  },
  {
    file: "services/telegraph/coordinationSessions.ts",
    writer: "user_door",
    guard: "shared",
    owner: "telegraph",
    note:
      "The one writer of a COORDINATION_SESSION row. It does not authorize and says so; its two callers do — " +
      "the coordination route and POST /telegraph/commands (server/telegraph/commandRoute.ts), which now runs " +
      "the shared guard before CREATE_COORDINATION_SESSION and ADD_REACTION. The suite checks the CALLER.",
  },

  // ── user doors with known gaps (see KNOWN_WEAK_DOOR_CEILING) ───────────────
  {
    file: "routes/telegraphChat.ts",
    writer: "user_door",
    missing: ["stop", "block", "rate"],
    owner: "telegraph",
    note:
      "start-poll from an AI suggestion. Holds membership and the E2EE refusal; a person in a 1:1 thread with " +
      "someone who blocked them can still post the poll card. Next Telegraph wave.",
  },
  {
    file: "routes/hiddenGems.ts",
    writer: "user_door",
    missing: ["stop", "block", "e2ee", "rate"],
    owner: "discovery",
    note:
      "POST /hidden-gems/:id/share-telegraph. Membership only, the membership read's error is not bound, the " +
      "card is plaintext written into whatever thread is named — including an E2EE one — and the insert's " +
      "result is not checked, so a failed write answers ok:true. Should become a call to POST /threads/:id/share.",
  },
  {
    file: "routes/highlights.ts",
    writer: "user_door",
    missing: ["stop", "e2ee", "rate"],
    owner: "highlights-memories",
    note:
      "The highlight reply. It resolves messaging permission (which covers blocks) but writes the reply as " +
      "plaintext into the existing DM, which may be end-to-end encrypted.",
  },
  {
    file: "lib/threadMessage.ts",
    writer: "user_door",
    missing: ["stop", "block", "rate"],
    owner: "layover",
    note:
      "postPlainThreadMessage, called by the layover Telegraph route into a TRIP thread after an accepted-" +
      "membership check. Refuses E2EE. A trip thread is a group, so the pairwise block guard would not fire.",
  },

  // ── server-authored rows ───────────────────────────────────────────────────
  { file: "lib/calls/callStoreAdapter.ts", writer: "system_writer", owner: "calls", note: "Call history lines, written when a call session ends." },
  { file: "lib/calls/callSignaling.ts", writer: "system_writer", owner: "calls", note: "Call history line on a signalling outcome." },
  { file: "routes/meetups.ts", writer: "system_writer", owner: "trips", note: "Meetup and meetup-confirmed cards, written by the meetup routes after their own authorization." },
  { file: "routes/rentABuddy.ts", writer: "system_writer", owner: "payments", note: "Booking milestone banners and booking cards, written on a booking state change." },
  { file: "routes/events.ts", writer: "system_writer", owner: "events", note: "The pinned event context card, posted once when the event thread is created." },
  { file: "routes/circle.ts", writer: "system_writer", owner: "circles", note: "Circle status cards (arrived, meeting point) into the circle thread." },
  { file: "services/notifications/NotificationRouter.ts", writer: "system_writer", owner: "notifications", note: "Telegraph delivery of a platform notification." },
];

/**
 * User doors that are known not to hold every gate. A CEILING: it may only fall.
 * Closing a door means removing its `missing` list and lowering this by one.
 */
export const KNOWN_WEAK_DOOR_CEILING = 4;

export function knownWeakDoors(): readonly MessageWriterDeclaration[] {
  return MESSAGE_WRITERS.filter((d) => d.writer === "user_door" && (d.missing?.length ?? 0) > 0);
}
