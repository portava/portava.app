/**
 * Telegraph §13.1 — the command vocabulary, and which commands a single
 * endpoint may issue.
 *
 * §13.1 lists eighteen commands. census-telegraph scored them individually and
 * found the enforcement scattered: `SEND_MESSAGE` is a route, `BLOCK_USER` is a
 * different route in a different file, `CREATE_DECISION` exists only in the
 * meetup shape, `UNSEND_MESSAGE` and `ADD_REACTION` do not exist at all. That
 * is not a defect in itself — a command bus is not automatically better than
 * eighteen endpoints — but it does mean there is no ONE list, so nothing can
 * say which of the eighteen exist without a reader going and looking.
 *
 * THE ALLOWLIST IS THE POINT, AND IT IS SMALL ON PURPOSE
 * =====================================================
 * `ISSUABLE_COMMANDS` is the set this repository's command endpoint may issue,
 * and it contains only commands that have NO legacy writer. `SEND_MESSAGE` is
 * refused here — not because it is unimplemented but because it IS implemented,
 * at `POST /threads/:id/messages`, with a block guard, an E2EE gate, a rate
 * limit, an off-app detector and a translation pipeline attached. Issuing it
 * through a generic bus would route around all five. This is the same rule
 * `server/trips/commandRoute.ts` applies for the same reason, and
 * `LEGACY_PATH_COMMANDS` names each refusal's real home so the error can say
 * where to go instead of "unknown command".
 *
 * ADDING A COMMAND TO THE ALLOWLIST IS A DECISION, NOT A CHORE
 * ===========================================================
 * A command missing from both sets is refused as unknown, which is the safe
 * direction to be wrong in: a new command reaches the endpoint only when
 * somebody has decided which side of the cutover it is on.
 */

import type { TelegraphReason } from "../contracts/telegraphReasonCodes.js";
import { dispatchTable } from "../contracts/dispatchTable.js";

/** §13.1, verbatim and in the spec's order. */
export const TELEGRAPH_COMMANDS = [
  "SEND_MESSAGE",
  "EDIT_MESSAGE",
  "UNSEND_MESSAGE",
  "DELETE_MESSAGE",
  "ADD_REACTION",
  "ACCEPT_REQUEST",
  "DECLINE_REQUEST",
  "CREATE_DECISION",
  "CAST_VOTE",
  "CREATE_COORDINATION_SESSION",
  "SET_COORDINATION_STATUS",
  "SHARE_LOCATION",
  "STOP_LOCATION_SHARE",
  "SET_AVAILABILITY",
  "STOP_AVAILABILITY",
  "BLOCK_USER",
  "MUTE_THREAD",
  "REPORT_MESSAGE",
] as const;
export type TelegraphCommandType = (typeof TELEGRAPH_COMMANDS)[number];

/**
 * Commands not in §13.1 that this endpoint nonetheless issues.
 *
 * `REMOVE_REACTION` is the only one. §13.1 names `ADD_REACTION` and no removal,
 * which reads as an oversight rather than a decision: a reaction a person
 * cannot take back is a message they cannot unsend, and §7.4 exists precisely
 * because that is unacceptable. It is listed separately rather than smuggled
 * into the §13.1 array so the census can see that the spec list is intact.
 */
export const TELEGRAPH_COMMAND_EXTENSIONS = ["REMOVE_REACTION"] as const;
export type TelegraphCommandExtension = (typeof TELEGRAPH_COMMAND_EXTENSIONS)[number];

export type IssuableCommand = TelegraphCommandType | TelegraphCommandExtension;

/**
 * What the command endpoint may issue: commands with NO legacy writer.
 *
 * Two today. Both are new capabilities that migration 2810/2811 made
 * representable and that no route has ever offered, so there is nothing to
 * route around.
 */
export const ISSUABLE_COMMANDS: readonly IssuableCommand[] = [
  "UNSEND_MESSAGE",   // §7.4 / §13.1 — needs messages.unsent_at (2810)
  "ADD_REACTION",     // §12 / §13.1 — needs message_reactions (2811)
  "REMOVE_REACTION",  // see TELEGRAPH_COMMAND_EXTENSIONS
];

const ISSUABLE = new Set<string>(ISSUABLE_COMMANDS);

export function isIssuable(command: string): command is IssuableCommand {
  return ISSUABLE.has(command);
}

/**
 * Commands that ALREADY have a home, and where it is.
 *
 * The value is the refusal message's content. A caller that sends
 * `SEND_MESSAGE` here gets told the route that sends messages, rather than
 * "unknown command" — which is the difference between a contract and a wall.
 */
export const LEGACY_PATH_COMMANDS: Readonly<Record<string, string>> = dispatchTable({
  SEND_MESSAGE: "POST /api/threads/:threadId/messages",
  EDIT_MESSAGE: "PATCH /api/messages/:messageId",
  DELETE_MESSAGE: "DELETE /api/messages/:messageId",
  ACCEPT_REQUEST: "POST /api/message-requests/:requestId/accept",
  DECLINE_REQUEST: "POST /api/message-requests/:requestId/decline",
  // Two doors each, and BOTH are named. §8's general decision shipped on the
  // coordination route — `kind: DECISION` with four resolution rules, a
  // deadline and options, answered by `kind: VOTE` — while these entries still
  // sent every caller to the meetup shape, and `CAST_VOTE` named a TABLE rather
  // than an endpoint anyone could be sent to. Naming only the general home
  // would be the same mistake reversed: T83's meetup triple and T167's RSVP are
  // both C and are still the right door for a meetup.
  CREATE_DECISION:
    "POST /api/threads/:threadId/coordination with kind DECISION (general), " +
    "or POST /api/telegraph-chat/create-meetup or /start-poll (meetup shape)",
  CAST_VOTE:
    "POST /api/threads/:threadId/coordination with kind VOTE (general), " +
    "or the meetup RSVP surface (meetup_time_votes)",
  SHARE_LOCATION: "POST /api/me/safe-return/sessions (Safe Return live share)",
  STOP_LOCATION_SHARE: "POST /api/me/safe-return/sessions/:id/live-share/stop",
  SET_AVAILABILITY: "POST /api/me/availability-windows",
  STOP_AVAILABILITY: "DELETE /api/me/availability-windows/:id",
  BLOCK_USER: "POST /api/users/:userId/block",
  MUTE_THREAD: "POST /api/threads/:threadId/mute",
  REPORT_MESSAGE: "POST /api/messages/:messageId/report",
  // §9.1's seven quick states ARE this command, on the coordination route.
  // This entry used to sit in UNIMPLEMENTED_COMMANDS below, saying "the §9.1
  // vocabulary does not exist" — which stopped being true when §9's
  // coordination surface landed (COORDINATION_QUICK_STATES, the COORDINATION
  // message kind, the panel). A refusal that tells a caller a thing does not
  // exist when it does is worse than no refusal: it sends them away from the
  // route that would have worked.
  SET_COORDINATION_STATUS: "POST /api/threads/:threadId/coordination with kind COORDINATION",
  // §9's CoordinationSession IS this command, on the same route. This entry
  // used to sit in UNIMPLEMENTED_COMMANDS below, saying "no coordination
  // session ENTITY exists (census T85/T168)" — for exactly as long as it took
  // §9's coordination surface to build one and for nobody to come back here.
  // A session now has an id (the opening message's own), a startedBy, a
  // recordable DISRUPTED and an endedAt set only on COMPLETE or CANCELLED
  // (`services/telegraph/coordination.ts` projectCoordinationSession), and the
  // route that opens one is mounted with no flag and no migration behind it.
  // The sentence above SET_COORDINATION_STATUS applies here unchanged: a
  // refusal that says a thing does not exist when it does sends a caller away
  // from the route that would have worked.
  CREATE_COORDINATION_SESSION: "POST /api/threads/:threadId/coordination with kind COORDINATION_SESSION",
});

/**
 * §13.1 commands that exist nowhere at all — DERIVED, not hand-listed.
 *
 * The endpoint's refusal distinguishes "go there instead" (409) from "this does
 * not exist yet" (501), which are different answers and lead a caller to
 * different actions. Which commands are in which category is a FACT ABOUT THE
 * OTHER TWO LISTS, so it is computed from them rather than maintained beside
 * them.
 *
 * WHY DERIVED, AND IT IS NOT TIDINESS. This list was hand-written and it went
 * stale in the direction that costs a caller the most. It held
 * `CREATE_COORDINATION_SESSION` with the note "no coordination session ENTITY
 * exists (census T85/T168)" — accurate when written, and still sitting here
 * long after §9's coordination surface shipped one. So `POST
 * /api/telegraph/commands` answered **501 "nothing in this repository
 * implements it"** about a command `POST /api/threads/:threadId/coordination`
 * implements today, with no flag and no migration behind it. That is the exact
 * failure `SET_COORDINATION_STATUS` was moved out of this list for, one entry
 * earlier and in this file's own words. A hand list rots silently in that
 * direction because nothing fails when it does; a derivation cannot.
 *
 * TODAY IT IS EMPTY, and that is a measurement: all eighteen §13.1 commands
 * have a home — sixteen in `LEGACY_PATH_COMMANDS`, two in `ISSUABLE_COMMANDS`.
 * The 501 branch in `server/telegraph/commandRoute.ts` is therefore currently
 * unreachable, and it is still the RIGHT branch: a nineteenth command added to
 * `TELEGRAPH_COMMANDS` with nowhere to go lands here automatically and gets the
 * 501 rather than a bare "Unknown command", which would tell a caller that a
 * name the SPECIFICATION uses was invented. `unimplementedCommandsFrom` below
 * is the rule, unit-tested against a hypothetical command so the behaviour is
 * covered while the live answer is empty.
 *
 * Having a home is NOT the same as being reachable. `UNSEND_MESSAGE` and
 * `ADD_REACTION` are issuable here and answer `feature_disabled` on every
 * deployment, because their schema (2810/2811) is in no database. That is the
 * ceiling on census T161/T163, and this list cannot express it — a command with
 * a door that is locked is not a command with no door.
 */
export function unimplementedCommandsFrom(
  commands: readonly string[],
  issuable: readonly string[],
  legacy: Readonly<Record<string, string>>,
): string[] {
  const hasHome = new Set<string>(issuable);
  return commands.filter(
    (c) => !hasHome.has(c) && !Object.prototype.hasOwnProperty.call(legacy, c),
  );
}

export const UNIMPLEMENTED_COMMANDS: readonly string[] = Object.freeze(
  unimplementedCommandsFrom(TELEGRAPH_COMMANDS, ISSUABLE_COMMANDS, LEGACY_PATH_COMMANDS),
);

/** One command, as the wire carries it. */
export interface TelegraphCommandEnvelope {
  /** Idempotency across retries of the COMMAND, distinct from a message's own key. */
  commandId: string;
  type: string;
  conversationId: string;
  /** Command-specific arguments. Never an actor — see the route. */
  params: Record<string, unknown>;
}

/** What a command produced, or why it did not. */
export interface TelegraphCommandResult {
  ok: boolean;
  command: string;
  reason?: TelegraphReason;
  /** Present on success; the shape is per command and named in its handler. */
  data?: Record<string, unknown>;
}

export function refusal(command: string, reason: TelegraphReason): TelegraphCommandResult {
  return { ok: false, command, reason };
}

export function success(command: string, data: Record<string, unknown> = {}): TelegraphCommandResult {
  return { ok: true, command, data };
}
