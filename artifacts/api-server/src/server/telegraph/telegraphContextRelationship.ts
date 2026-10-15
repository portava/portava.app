/**
 * Telegraph §30A.19 — the Context Kernel's RELATIONSHIP input, and the one
 * place the §14.1 capability policy takes its relationship term from
 * (census-telegraph T439, T381).
 *
 * §30A.1: "Relationship policy is an input to ConversationPolicy; it is not a
 * replacement for block, age, safety, membership, or object-specific
 * authorization." The kernel's first input IS §30A.1's canonical relationship
 * (services/telegraph/telegraphRelationship.ts — not a new resolver: that one
 * reads follows, friendship, trips and circles through lib/messagingPermissions'
 * canMessage, the resolver Nearby already consumes), and this module is the
 * only door through which the policy and the kernel's composer reach it.
 * `src/test/telegraphContextKernelGuard.test.ts` pins that.
 *
 * ── TWO FLAGS, BOTH HONOURED ────────────────────────────────────────────────
 * The relationship has its own flag (`telegraph_relationship_context_enabled`,
 * 3662, seeded FALSE): with it off the input is `not_consulted` — the kernel
 * does not reach past a source's own switch. Its state is read three-valued: an
 * unreadable flag is `degraded`, never "off".
 *
 * ── FAIL DIRECTION ──────────────────────────────────────────────────────────
 * The resolver answers `{ degraded: true }` for any failed read and this module
 * keeps that; a THROWN read (a torn-down client, a rejected fetch) is the same
 * unknown and answers the same way. No value is ever built from a failed read.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { readFlagState } from "../../lib/featureFlags.js";
import { readTelegraphRelationship, type RelationshipRead } from "../../services/telegraph/telegraphRelationship.js";
import {
  degradedInput,
  notConsultedInput,
  readInput,
  type ContextInput,
  type KernelRelationshipValue,
} from "../../domain/telegraph/contracts/telegraphContextKernel.js";

/**
 * The relationship between `viewerId` and `otherId`, as a kernel input.
 * `otherId` must be the other member of a direct conversation; the caller
 * decides that (the policy and the composer both read the roster themselves).
 */
export async function readKernelRelationship(
  sc: SupabaseClient,
  viewerId: string,
  otherId: string,
): Promise<ContextInput<KernelRelationshipValue>> {
  const flag = await readFlagState(sc, "telegraph_relationship_context_enabled"); // RELATIONSHIP_CONTEXT_FLAG (3662), as a literal for check:flag-polarity
  if (flag === "unknown") return degradedInput("KERNEL_SOURCE_UNREADABLE");
  if (flag !== "on") return notConsultedInput("KERNEL_SOURCE_OFF");

  let read: RelationshipRead;
  try {
    read = await readTelegraphRelationship(sc, viewerId, otherId);
  } catch {
    return degradedInput("KERNEL_SOURCE_UNREADABLE"); // a THROWN read is the same unknown as a returned failure
  }
  if (read.degraded) return degradedInput("KERNEL_SOURCE_UNREADABLE");
  return readInput({
    state: read.relationship.state,
    origins: read.relationship.origins,
    expiredOrigins: read.relationship.expiredOrigins,
    messagingFloor: read.messagingFloor,
  });
}
