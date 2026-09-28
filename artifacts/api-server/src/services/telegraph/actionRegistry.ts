/**
 * Telegraph §30A.10 — the executable-action capability registry.
 *
 * Spec §30A.10, verbatim:
 *   "Every executable Telegraph action registers authorize, preview, execute,
 *    and optional compensate behavior. Telegraph orchestrates; Trips, Events,
 *    Buddy, Memories, Discovery, and other source domains retain canonical
 *    business truth."
 *
 * ── THE DEFECT THIS CLOSES ──────────────────────────────────────────────────
 * census-telegraph T410: "The orchestration half is genuinely right (T288,
 * T441). Three of four hooks exist for **one** action family:
 * `ProposedAction.label` (preview), `confirm-action` (execute), and `:390`'s
 * re-verification (authorize) — `routes/telegraphCommands.ts:53-59,390-444`.
 * **No registry, no compensate.**"
 *
 * Re-derived before this file was written and still true then: the four hooks
 * were four inline stretches of one handler, keyed off nothing, and a fifth
 * `ProposedAction.kind` could be added to `buildResponse` with no hook of any
 * kind and no check anywhere would notice.
 *
 * ── WHAT A REGISTRY BUYS THAT A HANDLER DOES NOT ────────────────────────────
 * Exhaustiveness. `src/test/telegraphCommandRoute.test.ts` reads the route's
 * own source, extracts every `kind: "…"` literal it can produce, and fails if
 * any of them is absent from `TELEGRAPH_ACTION_REGISTRY`. A new action is then
 * a compile-and-CI event rather than a silent one, which is the only property
 * that makes the word "every" in §30A.10 mean anything.
 *
 * ── WHY `execute` DOES NOT WRITE THE CANONICAL OBJECT ───────────────────────
 * §30A.10's second sentence is a prohibition: source domains retain canonical
 * business truth. So `execute` here performs the one write Telegraph is
 * entitled to make — the ORCHESTRATION RECORD that this person confirmed this
 * action — and every registration names, in `canonicalOwner`, the domain and
 * the surface that performs the real write. A registration that claimed
 * Telegraph owned the truth would be refused by the test, not by review.
 *
 * ── WHY compensate IS NOT DECORATION ────────────────────────────────────────
 * §30A.11: "Current source-domain capability is rechecked at execution time so
 * expired events, revoked invitations, changed bookings, and removed
 * memberships fail safely." A recheck AFTER a write needs an undo, or "fail
 * safely" means "leave a confirmation nothing backs". `compensate` is that
 * undo, it is reachable — `routes/telegraphCommands.ts` calls it when the
 * post-write recheck fails — and it is asserted by deleting the row, not by
 * reporting that it did.
 *
 * An action that writes nothing declares `{ reason }` instead of a function.
 * "Optional" in §30A.10 means optional to IMPLEMENT, not optional to ANSWER:
 * a registration that simply omitted the field would be indistinguishable from
 * one whose author forgot.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { isAcceptedTripMember } from "../../lib/http.js"; import { isFlagEnabled } from "../../lib/featureFlags.js"; import { fetchBlockedSet } from "../../lib/blocks.js"; import { saveDiscoveryPlace, unsaveDiscoveryPlace, DISCOVERY_OSM_PLACE_ID } from "../discovery/DiscoveryWishlistSave.js"; // census-discovery §81

/** §30A.10's four hooks, verbatim and in the spec's order. */
export const ACTION_HOOKS = ["authorize", "preview", "execute", "compensate"] as const;

export type ActionHook = (typeof ACTION_HOOKS)[number];

/** Everything a hook is allowed to see. No request, no response, no express. */
export interface ActionContext {
  client: SupabaseClient;
  userId: string;
  /** The trip the command was scoped to, when it was scoped to one. */
  tripId: string | null;
  /** The command and action this confirmation belongs to. */
  commandId: string;
  actionId: string;
  label: string;
  params: Record<string, string>;
  /** The preference category the orchestration record is filed under. */
  category: string;
}

export interface ActionAuthorization {
  authorized: boolean;
  /** Always present. A refusal a caller cannot read is a refusal nobody fixes. */
  reason: string;
}

export interface ActionExecution {
  /** True when the orchestration record landed. */
  recorded: boolean;
  /** The id that record is keyed by, so `compensate` can find exactly it. */
  recordId: string;
  /** Set when the record did NOT land, naming why. Never silent. */
  degraded: string | null; /** census-discovery §81: set when the owning domain's CANONICAL write did not happen — nothing confirmed was done, so the route must not answer "confirmed". Absent where the canonical write belongs to another surface. */ failed?: string | null;
}

export interface ActionCompensation {
  undone: boolean;
  what: string;
}

export type CompensateHook =
  | { run: (ctx: ActionContext, execution: ActionExecution) => Promise<ActionCompensation> }
  /** No undo because there is nothing to undo, and this says which. */
  | { reason: string };

export interface CanonicalOwner {
  /** Never "telegraph" — the test refuses that value. */
  domain: string;
  /** The surface that performs the canonical write. */
  surface: string;
}

export interface TelegraphActionRegistration {
  /** The `ProposedAction.kind` this registration answers for. */
  actionId: string;
  canonicalOwner: CanonicalOwner;
  preview(ctx: ActionContext): string;
  authorize(ctx: ActionContext): Promise<ActionAuthorization>;
  execute(ctx: ActionContext): Promise<ActionExecution>;
  compensate: CompensateHook;
}

// ── the shared hooks ─────────────────────────────────────────────────────────

/**
 * The authorization every trip-scoped action shares: accepted membership of
 * the trip, re-derived from `trip_members` at the moment of confirmation and
 * never taken from the card that proposed it (§30A.11).
 *
 * `isAcceptedTripMember` THROWS on an unreadable `trip_members` — see
 * `lib/http.ts` — so an outage becomes a refusal here rather than a silent
 * true, which is the direction this gate has to fail in.
 */
async function requireTripScope(ctx: ActionContext): Promise<ActionAuthorization> {
  if (!ctx.tripId) {
    return {
      authorized: true,
      reason: "The command carried no trip, so nothing trip-scoped is being authorized.",
    };
  }
  try {
    const ok = await isAcceptedTripMember(ctx.client, ctx.tripId, ctx.userId);
    return ok
      ? { authorized: true, reason: "Accepted member of the trip this action writes to." }
      : { authorized: false, reason: "You must be an accepted trip member to confirm this action" };
  } catch {
    return {
      authorized: false,
      reason: "We could not check your membership of this trip right now. Please try again shortly.",
    };
  }
}

/** Nothing canonical is written, so there is nothing to authorize against. */
async function alwaysAuthorized(_ctx: ActionContext): Promise<ActionAuthorization> {
  return {
    authorized: true,
    reason: "This action writes nothing canonical; it continues the conversation.",
  };
}

/**
 * The ONE write Telegraph makes on a confirmation: the record that this person
 * confirmed this action, which the preference learner reads.
 *
 * It is deliberately not fatal. A failed analytics write must not turn a
 * confirmation into an error the traveller has to retry — but it must not be
 * invisible either, so `degraded` carries the reason and the route reports it.
 */
async function recordConfirmation(ctx: ActionContext): Promise<ActionExecution> {
  const recordId = `${ctx.commandId}:${ctx.actionId}`;
  const { error } = await ctx.client.from("user_preference_events").insert({
    user_id: ctx.userId,
    recommendation_id: recordId,
    category: ctx.category,
    signal: "tap",
    trip_id: ctx.tripId ?? null,
    created_at: new Date().toISOString(),
  });
  if (error) {
    return { recorded: false, recordId, degraded: error.message ?? "preference event insert failed" };
  }
  return { recorded: true, recordId, degraded: null };
}

/** The undo for `recordConfirmation`, keyed by the id it returned. */
const undoConfirmation: CompensateHook = {
  async run(ctx, execution) {
    if (!execution.recorded) {
      return { undone: true, what: "nothing was written, so nothing was undone" };
    }
    const { error } = await ctx.client
      .from("user_preference_events")
      .delete()
      .eq("user_id", ctx.userId)
      .eq("recommendation_id", execution.recordId);
    if (error) {
      return { undone: false, what: `could not remove ${execution.recordId}: ${error.message}` };
    }
    return { undone: true, what: `removed the orchestration record ${execution.recordId}` };
  },
};

function previewOf(what: string) {
  return (ctx: ActionContext) => {
    const detail = ctx.params.title ?? ctx.params.category ?? ctx.params.action ?? null;
    return detail ? `${what}: ${detail}` : what;
  };
}

// ── the registry ─────────────────────────────────────────────────────────────

/**
 * Every executable action this tree can propose, with all four hooks.
 *
 * The list is checked against `routes/telegraphCommands.ts`'s own source by
 * `src/test/telegraphCommandRoute.test.ts`, so it cannot fall behind the route
 * that produces the actions.
 */
export const TELEGRAPH_ACTION_REGISTRY: readonly TelegraphActionRegistration[] = [
  {
    actionId: "add_to_plan",
    canonicalOwner: {
      domain: "trips",
      surface:
        "POST /api/threads/:threadId/telegraph/suggestions/:suggestionId/add-to-plan " +
        "(routes/telegraphChat.ts), which re-verifies accepted trip membership itself",
    },
    preview: previewOf("Add this to the trip plan"),
    authorize: requireTripScope,
    execute: recordConfirmation,
    compensate: undoConfirmation,
  },
  {
    actionId: "create_meetup",
    canonicalOwner: {
      domain: "meetups",
      surface:
        "POST /api/threads/:threadId/telegraph/suggestions/:suggestionId/create-meetup " +
        "(routes/telegraphChat.ts)",
    },
    preview: previewOf("Create a meetup"),
    authorize: requireTripScope,
    execute: recordConfirmation,
    compensate: undoConfirmation,
  },
  {
    actionId: "open_poll",
    canonicalOwner: {
      domain: "meetups",
      surface:
        "POST /api/threads/:threadId/telegraph/suggestions/:suggestionId/start-poll " +
        "(routes/telegraphChat.ts) for a time poll; POST /api/threads/:id/coordination " +
        "kind DECISION for a free-form question",
    },
    preview: previewOf("Open a poll"),
    authorize: requireTripScope,
    execute: recordConfirmation,
    compensate: undoConfirmation,
  },
  {
    actionId: "ask_followup",
    canonicalOwner: {
      domain: "compass",
      surface: "POST /api/telegraph/commands — a follow-up question, answered in the conversation",
    },
    preview: previewOf("Ask Telegraph something else"),
    authorize: alwaysAuthorized,
    execute: recordConfirmation,
    /**
     * This one DOES write the orchestration record — a follow-up is still a
     * tap the learner should see — so it gets the same undo. It is listed
     * separately rather than sharing a spread, because a registration that
     * inherited its hooks from a neighbour is a registration nobody reads.
     */
    compensate: undoConfirmation,
  },
  {
    actionId: "discovery_save_place",
    canonicalOwner: {
      domain: "discovery",
      surface:
        "services/discovery/DiscoveryWishlistSave.ts saveDiscoveryPlace — the write POST /api/wishlist " +
        "(routes/wishlist.ts, Discovery's bookmark sync) performs, list 'global'",
    },
    preview: (ctx) => `Save ${ctx.params.title ? `"${ctx.params.title}"` : "this place"} to your saved places`,
    authorize: authorizeDiscoverySave,
    execute: executeDiscoverySave,
    compensate: { run: runUndoDiscoverySave }, // a function declaration below: hoisted, so the registry can name it before the §81 block
  },
];

const BY_ID = new Map(TELEGRAPH_ACTION_REGISTRY.map((r) => [r.actionId, r]));

export function registeredActionIds(): string[] {
  return [...BY_ID.keys()];
}

/** Null for an action nobody registered. The route REFUSES those. */
export function registrationFor(actionId: string): TelegraphActionRegistration | null {
  return BY_ID.get(actionId) ?? null;
}

/** True when a compensate hook is a real undo rather than a stated absence. */
export function hasUndo(hook: CompensateHook): hook is { run: NonNullable<any> } {
  return typeof (hook as { run?: unknown }).run === "function";
}

/**
 * Run the compensate hook, whatever shape it has.
 *
 * One caller, one place where "there is no undo" and "the undo ran" are told
 * apart, so the route cannot accidentally report a stated-absence as an undo.
 */
export async function compensateFor(
  reg: TelegraphActionRegistration,
  ctx: ActionContext,
  execution: ActionExecution,
): Promise<ActionCompensation> {
  if (hasUndo(reg.compensate)) return reg.compensate.run(ctx, execution);
  return { undone: false, what: (reg.compensate as { reason: string }).reason };
}

// ── Discovery: save a shared place (census-discovery §81, A21; D-W10S2-5) ────
//
// Telegraph spec §30A.10: *"Every executable Telegraph action registers
// authorize, preview, execute, and optional compensate behavior. Telegraph
// orchestrates; … Discovery, and other source domains retain canonical business
// truth."* §30A.11: *"Rich-card actions follow tap -> command -> owning domain
// authorization/write"*. The shared Discovery card's Save button called
// Discovery's bookmark sync straight from the client, so Telegraph never
// authorized, previewed or executed it. This is that action, as a registration.
//
// It differs from the four above in ONE respect, and on purpose: its execute
// performs the canonical write — by calling DISCOVERY'S service
// (`services/discovery/DiscoveryWishlistSave.ts`, the same function
// `POST /api/wishlist` calls), never by writing a Discovery table itself. The
// four above leave the canonical write to a separate owning-domain endpoint;
// here the tap IS the command, so the owning domain's write runs inside it.
//
// Gated by `telegraph_discovery_actions_enabled` (migration 3467, seeded
// FALSE): the command that proposes it answers `feature_disabled` while the
// flag is off, and authorize re-reads the flag at confirmation and again at the
// post-write recheck, so switching it off between the tap and the confirmation
// refuses — and undoes a save this action created.

/** Seeded FALSE by migration 3467. */
export const TELEGRAPH_DISCOVERY_ACTIONS_FLAG = "telegraph_discovery_actions_enabled";

/** The list the Discovery card's own Save writes to (discoveryBookmarks' `listId = 'global'`). */
export const DISCOVERY_SAVE_LIST = "global";

const DISCOVERY_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * May THIS person save THIS place, now? Re-derived at the confirmation and at
 * the recheck, never taken from the card (§30A.8 "An old rendered card must not
 * authorize a stale action"):
 *   - the capability is on;
 *   - the id is one Discovery serves: a curated uuid or an OSM element id;
 *   - a curated place still exists and is `active`, and its submitter is not
 *     blocked with the viewer in either direction (Discovery's own rule for
 *     serving a community place).
 * Every unreadable source refuses.
 */
async function authorizeDiscoverySave(ctx: ActionContext): Promise<ActionAuthorization> {
  if (!(await isFlagEnabled(ctx.client, TELEGRAPH_DISCOVERY_ACTIONS_FLAG))) {
    return { authorized: false, reason: "Saving places from a conversation is not enabled." };
  }
  const placeId = ctx.params.placeId ?? "";
  if (DISCOVERY_OSM_PLACE_ID.test(placeId)) {
    return { authorized: true, reason: "A map place Discovery serves; anyone may save it." };
  }
  if (!DISCOVERY_UUID.test(placeId)) {
    return { authorized: false, reason: "That is not a place Discovery can save." };
  }
  const { data: place, error } = await ctx.client
    .from("discovery_places")
    .select("id, status, submitted_by")
    .eq("id", placeId)
    .maybeSingle();
  if (error) {
    return { authorized: false, reason: "We could not check this place right now. Please try again shortly." };
  }
  if (!place || (place as { status?: unknown }).status !== "active") {
    return { authorized: false, reason: "This place is no longer available to save." };
  }
  const submitter = (place as { submitted_by?: unknown }).submitted_by;
  if (typeof submitter === "string" && submitter !== ctx.userId) {
    const blocked = await fetchBlockedSet(ctx.client, ctx.userId);
    if (blocked === null) {
      return { authorized: false, reason: "We could not check this place right now. Please try again shortly." };
    }
    if (blocked.has(submitter)) return { authorized: false, reason: "This place is no longer available to save." };
  }
  return { authorized: true, reason: "An active Discovery place you may be shown." };
}

/** The card fields the save carries, exactly the shape the client's own Save sends. */
function discoverySavePayload(ctx: ActionContext): Record<string, unknown> {
  return {
    id: ctx.params.placeId,
    name: ctx.params.title ?? null,
    category: ctx.params.category ?? null,
    type: ctx.params.type ?? null,
    address: ctx.params.city ?? null,
  };
}

async function executeDiscoverySave(ctx: ActionContext): Promise<ActionExecution> {
  const placeId = ctx.params.placeId ?? "";
  const { trackOsmPlaceSave } = await import("../../routes/wishlist.js");
  const saved = await saveDiscoveryPlace(
    ctx.client, ctx.userId,
    { placeId, placeData: discoverySavePayload(ctx), listId: DISCOVERY_SAVE_LIST },
    { detectCreated: true, trackOsm: trackOsmPlaceSave },
  );
  if (!saved.ok) {
    return { recorded: false, recordId: `wishlist:${DISCOVERY_SAVE_LIST}:${placeId}`, degraded: null, failed: saved.message };
  }
  // The id says whether THIS action created the save, so compensate removes
  // exactly its own write and never a save the person already had.
  return {
    recorded: true,
    recordId: `wishlist:${DISCOVERY_SAVE_LIST}:${placeId}:${saved.created ? "created" : "existing"}`,
    degraded: null,
    failed: null,
  };
}

async function runUndoDiscoverySave(ctx: ActionContext, execution: ActionExecution): Promise<ActionCompensation> {
  {
    if (!execution.recorded) return { undone: true, what: "nothing was saved, so nothing was undone" };
    if (!execution.recordId.endsWith(":created")) {
      return { undone: true, what: "the place was already saved before this action, so the save was kept" };
    }
    const r = await unsaveDiscoveryPlace(ctx.client, ctx.userId, ctx.params.placeId ?? "", DISCOVERY_SAVE_LIST);
    if (!r.ok) return { undone: false, what: `could not remove the save this action made: ${r.message}` };
    return { undone: true, what: "removed the save this action made" };
  }
}
