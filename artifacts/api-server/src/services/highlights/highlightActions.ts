/**
 * §12 Highlight actions — DO THIS / SAVE / ADD TO TRIP / VIEW PLACE / ASK / MEET.
 *
 * SPEC: Portava Highlights / Memories Development Architecture Specification v1
 *   §12 "Actions: DO THIS, SAVE, ADD TO TRIP, VIEW PLACE, ASK, MEET (when
 *        socially appropriate)", and §1 "Highlights are Portava's curated window
 *        into a person's real-world life … turn past experience into new
 *        real-world action."
 *
 * CENSUS: H102 was NOT-BUILT — "The viewer offers like, reply, report — the
 *         engagement verbs of a Stories product, not the action verbs of an
 *         executable Highlight."
 *
 * ── WHERE A HIGHLIGHT'S PLACE COMES FROM ─────────────────────────────────────
 * Not from the Highlight. `public.highlights` carries `location_name` /
 * `location_city` as free text and no place reference; turning that text into a
 * catalog place would be §28.3's "semantic substitute for an unknown canonical
 * place". A Highlight's place is the place of the MEMORY it projects
 * (`highlight_sources`, 2722), and every venue action is the Memory action
 * (services/memory/memoryActionService.ts) on that Memory — compiled against the
 * world now, under the Memory's own §23 read gate for THIS viewer. A viewer who
 * may see the Highlight but not the Memory behind it gets no venue: the
 * Highlight showing them a picture is not the owner sharing where it was.
 *
 * A sourceless Highlight (every Story-style Highlight; H93) is said to be one:
 * `NO_SOURCE_MEMORY`. That is the truth about it, not a failure.
 *
 * ── ASK AND MEET ──────────────────────────────────────────────────────────────
 * ASK is the existing reply (`POST /highlights/:id/reply`), offered only when
 * the recipient's messaging rules would let it through — the same `canMessage`
 * verdict the reply route enforces, so the button and the send cannot disagree.
 * MEET is declared and refused by name: "when socially appropriate" is a
 * judgement nothing in this repository makes for a Highlight viewer today.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { logger as rootLogger } from "../../lib/logger.js";
import { canMessage } from "../../lib/messagingPermissions.js";
import type { HighlightRecord } from "../../lib/highlightPermissions.js";
import { readHighlightSources } from "./highlightSources.js";
import {
  ACTION_UNAVAILABLE_MESSAGE,
  buildActionMenu,
  loadMemoryForViewer,
  resolveCurrentPlace,
  viewerPlaceFor,
  type ActionDescriptor,
  type ActionUnavailableReason,
  type CatalogCaution,
  type CurrentPlace,
  type MemoryAction,
} from "../memory/memoryActionService.js";

const log = rootLogger.child({ mod: "highlightActions" });

export const HIGHLIGHT_ACTIONS = ["DO_THIS", "SAVE", "ADD_TO_TRIP", "VIEW_PLACE", "ASK", "MEET"] as const;
export type HighlightAction = (typeof HIGHLIGHT_ACTIONS)[number];

export const HIGHLIGHT_ONLY_REASONS = [
  "NO_SOURCE_MEMORY",
  "SOURCE_NOT_SHARED",
  "SOURCE_UNREADABLE",
  "SOURCE_STORE_UNAVAILABLE",
  "OWN_HIGHLIGHT",
  "MESSAGE_REQUEST_REQUIRED",
  "MESSAGING_NOT_ALLOWED",
  "MESSAGING_UNREADABLE",
  "CONSUMER_UNAVAILABLE",
] as const;
export type HighlightOnlyReason = (typeof HIGHLIGHT_ONLY_REASONS)[number];
export type HighlightActionReason = ActionUnavailableReason | HighlightOnlyReason;

const HIGHLIGHT_REASON_MESSAGE: Readonly<Record<HighlightOnlyReason, string>> = Object.freeze({
  NO_SOURCE_MEMORY: "This Highlight is not linked to a Memory, so Portava does not know its place.",
  SOURCE_NOT_SHARED: "The Memory behind this Highlight is not shared with you.",
  SOURCE_UNREADABLE: "The Memory behind this Highlight could not be checked right now. Please try again.",
  SOURCE_STORE_UNAVAILABLE: "This Highlight's link to its Memory could not be read right now. Please try again.",
  OWN_HIGHLIGHT: "This is your own Highlight.",
  MESSAGE_REQUEST_REQUIRED: "Send a message request first.",
  MESSAGING_NOT_ALLOWED: "This person is not taking messages from you.",
  MESSAGING_UNREADABLE: "Whether you can message this person could not be checked right now.",
  CONSUMER_UNAVAILABLE: "This is not available in the app yet.",
});

export interface HighlightActionDescriptor {
  action: HighlightAction;
  available: boolean;
  reason: HighlightActionReason | null;
  message: string | null;
  caution: CatalogCaution | null;
}

export interface HighlightActionMenu {
  highlightId: string;
  /** The Memory the venue actions run on — present ONLY when this viewer may read it. */
  sourceMemoryId: string | null;
  place: CurrentPlace | null;
  actions: HighlightActionDescriptor[];
}

/** §12 name → the Memory action it is. */
const FROM_MEMORY: Readonly<Partial<Record<HighlightAction, MemoryAction>>> = Object.freeze({
  DO_THIS: "DO_AGAIN",
  SAVE: "SAVE_EXPERIENCE",
  ADD_TO_TRIP: "ADD_TO_TRIP",
  VIEW_PLACE: "VIEW_PLACE",
});
const VENUE_SIDE: readonly HighlightAction[] = ["DO_THIS", "SAVE", "ADD_TO_TRIP", "VIEW_PLACE"];

function refusedH(action: HighlightAction, reason: HighlightOnlyReason): HighlightActionDescriptor {
  return { action, available: false, reason, message: HIGHLIGHT_REASON_MESSAGE[reason], caution: null };
}
function offeredH(action: HighlightAction): HighlightActionDescriptor {
  return { action, available: true, reason: null, message: null, caution: null };
}
function fromMemoryDescriptor(action: HighlightAction, d: ActionDescriptor | undefined): HighlightActionDescriptor {
  if (!d) return { action, available: false, reason: "NO_PLACE_REFERENCE", message: ACTION_UNAVAILABLE_MESSAGE.NO_PLACE_REFERENCE, caution: null };
  return { action, available: d.available, reason: d.reason, message: d.message, caution: d.caution };
}

async function askDescriptor(sc: SupabaseClient, highlight: HighlightRecord, viewerId: string): Promise<HighlightActionDescriptor> {
  if (viewerId === highlight.owner_id) return refusedH("ASK", "OWN_HIGHLIGHT");
  try {
    const verdict = await canMessage(sc, viewerId, highlight.owner_id);
    if (verdict.allowed) return offeredH("ASK");
    if (verdict.verdict === "requires_request") return refusedH("ASK", "MESSAGE_REQUEST_REQUIRED");
    // `unavailable` is canMessage's "a read this decision depends on FAILED":
    // permission is unknown, which is not the recipient saying no.
    return refusedH("ASK", verdict.reason === "unavailable" ? "MESSAGING_UNREADABLE" : "MESSAGING_NOT_ALLOWED");
  } catch (err) {
    log.error({ err, highlightId: highlight.id }, "highlight actions: messaging verdict threw — ASK withheld, not refused");
    return refusedH("ASK", "MESSAGING_UNREADABLE");
  }
}

/**
 * The §12 menu for a Highlight THIS viewer already passed the view gate for
 * (`resolveViewAccess`). Reads; never writes.
 */
export async function buildHighlightActionMenu(
  sc: SupabaseClient,
  highlight: HighlightRecord,
  viewerId: string,
): Promise<HighlightActionMenu> {
  const ask = await askDescriptor(sc, highlight, viewerId);
  const meet = refusedH("MEET", "CONSUMER_UNAVAILABLE");
  const withVenue = (venue: HighlightActionDescriptor[], sourceMemoryId: string | null, place: CurrentPlace | null): HighlightActionMenu => ({
    highlightId: highlight.id,
    sourceMemoryId,
    place,
    actions: [...venue, ask, meet],
  });
  const allVenue = (reason: HighlightOnlyReason) => withVenue(VENUE_SIDE.map((a) => refusedH(a, reason)), null, null);

  const sources = await readHighlightSources(sc, highlight.id);
  if (!sources.ok) {
    log.error({ highlightId: highlight.id, reason: sources.reason, detail: sources.detail }, "highlight actions: source links unreadable — venue actions withheld");
    return allVenue(sources.reason === "not_deployed" ? "SOURCE_STORE_UNAVAILABLE" : "SOURCE_UNREADABLE");
  }
  const source = sources.value.find((s) => s.sourceType === "MEMORY");
  if (!source) return allVenue("NO_SOURCE_MEMORY");

  const loaded = await loadMemoryForViewer(sc, source.sourceId, viewerId);
  if (loaded.state === "unreadable") return allVenue("SOURCE_UNREADABLE");
  if (loaded.state === "not_found") return allVenue("SOURCE_NOT_SHARED");

  const resolution = await resolveCurrentPlace(sc, loaded.memory);
  const viewerPlace = await viewerPlaceFor(sc, loaded.memory, viewerId, loaded.precisionGateOn, resolution);
  const memoryMenu = buildActionMenu({ memory: loaded.memory, viewerId, viewerPlace, savedByMe: null });
  const by = new Map(memoryMenu.actions.map((d) => [d.action, d] as const));
  const venue = VENUE_SIDE.map((a) => fromMemoryDescriptor(a, by.get(FROM_MEMORY[a]!)));
  return withVenue(venue, loaded.memory.id, memoryMenu.place);
}
