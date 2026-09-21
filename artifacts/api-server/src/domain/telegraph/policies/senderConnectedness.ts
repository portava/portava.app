/**
 * Telegraph §22 — "Stranger media can be blurred / no autoplay until accepted."
 *
 * census-telegraph T280: "`components/MessageMediaBubble.tsx:170` renders and
 * autoplays unconditionally. The request-acceptance gate means a stranger
 * cannot open a thread at all, which mitigates the risk but does not implement
 * the control."
 *
 * WHY THE SERVER DECIDES, NOT THE CLIENT
 * ======================================
 * "Stranger" is a fact about a social graph the client does not hold. A client
 * that decided it would have to fetch the friendship and follow edges for every
 * sender in every thread, would get the answer slightly wrong on a slow
 * network, and — the part that matters — would get it wrong in the permissive
 * direction, because an unanswered request renders as "no shield" unless
 * somebody remembers to make it render as the opposite. So the server answers
 * it once per page of messages and the client renders the answer.
 *
 * THE ANSWER IS PER SENDER, NOT PER MESSAGE
 * =========================================
 * One query pair for the whole page, keyed on the distinct non-self senders.
 * A per-message resolution would be N round trips for a shield that is, by
 * construction, the same for every message from the same person.
 *
 * FAIL-CLOSED MEANS SHIELDED
 * ==========================
 * If the relationship reads fail, every sender on the page is reported
 * UNCONNECTED and their media is shielded. That is a cosmetic cost — one extra
 * tap — against the alternative, which is that an unreadable `user_friendships`
 * during a bad minute silently switches an abuse control off. `degraded` is
 * returned alongside so a caller can distinguish "we checked and they are a
 * stranger" from "we could not check", and so the client can say the honest
 * thing if it ever wants to.
 *
 * WHAT "CONNECTED" MEANS HERE, EXACTLY
 * ====================================
 * Any ONE of: an accepted friendship in either direction; a follow in either
 * direction; or co-membership of a NON-direct thread (a trip or circle
 * conversation is itself an accepted context — the source domain decided who
 * belongs). It deliberately does NOT include "we are both in this DM", because
 * that is the condition the control exists to qualify.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

import { logger as rootLogger } from "../../../lib/logger.js";

const log = rootLogger.child({ mod: "telegraphSenderConnectedness" });

export interface ConnectednessResult {
  /** Sender ids the viewer has an established relationship with. */
  connected: ReadonlySet<string>;
  /** True when a relationship read failed — every sender then reads unconnected. */
  degraded: boolean;
}

export const EMPTY_CONNECTEDNESS: ConnectednessResult = { connected: new Set(), degraded: false };

/**
 * Resolve which of `senderIds` the viewer is connected to.
 *
 * `threadType` decides the shortcut: in a trip or circle thread every
 * participant is there because the source domain put them there, so the whole
 * page is connected without a query. Only `direct` threads need the graph.
 */
export async function resolveSenderConnectedness(
  sc: SupabaseClient,
  viewerId: string,
  senderIds: readonly string[],
  threadType: string,
): Promise<ConnectednessResult> {
  const others = [...new Set(senderIds.filter((id) => id && id !== viewerId))];
  if (others.length === 0) return EMPTY_CONNECTEDNESS;

  if (threadType !== "direct") {
    // A trip/circle roster IS the acceptance. Shielding a crew-mate's photo
    // would be a warning with no information in it, and a warning with no
    // information in it is how people learn to dismiss warnings.
    return { connected: new Set(others), degraded: false };
  }

  const connected = new Set<string>();
  let degraded = false;

  const { data: friendships, error: friendErr } = await sc
    .from("user_friendships")
    .select("user_a, user_b")
    .or(`user_a.eq.${viewerId},user_b.eq.${viewerId}`)
    .limit(500);
  if (friendErr) {
    degraded = true;
    log.warn({ err: friendErr, viewerId }, "connectedness: friendships unreadable — shielding");
  } else {
    for (const row of (friendships as any[]) ?? []) {
      const a = String(row.user_a), b = String(row.user_b);
      const other = a === viewerId ? b : a;
      if (others.includes(other)) connected.add(other);
    }
  }

  const { data: follows, error: followErr } = await sc
    .from("user_follows")
    .select("follower_id, following_id")
    .or(`follower_id.eq.${viewerId},following_id.eq.${viewerId}`)
    .limit(1000);
  if (followErr) {
    degraded = true;
    log.warn({ err: followErr, viewerId }, "connectedness: follows unreadable — shielding");
  } else {
    for (const row of (follows as any[]) ?? []) {
      const f = String(row.follower_id), g = String(row.following_id);
      const other = f === viewerId ? g : f;
      if (others.includes(other)) connected.add(other);
    }
  }

  // A failed read must not be rescued by the half that succeeded: if either
  // side is unknown, the answer for EVERY sender is "unknown", and unknown
  // shields. Returning the partial set would shield exactly the people the
  // successful half happened not to mention, which is arbitrary.
  if (degraded) return { connected: new Set(), degraded: true };
  return { connected, degraded: false };
}
