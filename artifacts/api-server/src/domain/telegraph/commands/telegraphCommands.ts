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
export const LEGACY_PATH_COMMANDS: Readonly<Record<string, string>> = {
  SEND_MESSAGE: "POST /api/threads/:threadId/messages",
  EDIT_MESSAGE: "PATCH /api/messages/:messageId",
  DELETE_MESSAGE: "DELETE /api/messages/:messageId",
  ACCEPT_REQUEST: "POST /api/message-requests/:requestId/accept",
  DECLINE_REQUEST: "POST /api/message-requests/:requestId/decline",
  CREATE_DECISION: "POST /api/telegraph-chat/create-meetup or /start-poll",
  CAST_VOTE: "the meetup RSVP surface (meetup_time_votes)",
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
};

/**
 * §13.1 commands that exist nowhere at all.
 *
 * Named so the endpoint's refusal can distinguish "go there instead" from
 * "this does not exist yet", which are different answers and lead a caller to
 * different actions.
 */
export const UNIMPLEMENTED_COMMANDS: readonly string[] = [
  "CREATE_COORDINATION_SESSION",  // §9 — no coordination session ENTITY exists (census T85/T168)
];

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
