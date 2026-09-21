/**
 * Telegraph Concierge Command Routes
 *
 * POST /api/telegraph/commands                          — submit a natural language command
 * GET  /api/telegraph/commands/:commandId               — get command result (own commands only)
 * POST /api/telegraph/commands/:commandId/confirm-action — confirm a proposed action (BOLA-checked)
 * POST /api/telegraph/commands/:commandId/decline-action — decline a proposed action (BOLA-checked)
 * GET  /api/trips/:tripId/telegraph/commands/history    — command history for a trip (member-gated)
 *
 * Security:
 *   - requireUser on every route.
 *   - commandStore entries include owner userId; GET/confirm/decline reject cross-user access (403).
 *   - ProposedActions all have requires_confirmation: true.
 *   - confirm-action re-verifies trip membership at execution time.
 */
import { Router } from "express";
import { z } from "zod";
import { logger as rootLogger } from "../lib/logger.js";
import { requireUser, sendError, isAcceptedTripMember } from "../lib/http.js";

const cmdLogger = rootLogger.child({ route: "telegraphCommands" });
import { resolveContext } from "../lib/privacyResolver.js";
import { getNearbyVenues, formatDistance, type NearbyVenue } from "../lib/venuesService.js";
import {
  compensateFor,
  registrationFor,
  type ActionContext,
} from "../services/telegraph/actionRegistry.js";

const router = Router();

const UUID = /^[0-9a-f-]{36}$/i;

/** Maps a Telegraph intent to the preference category that should be boosted on confirm. */
const INTENT_CATEGORY: Partial<Record<string, string>> = {
  find_food:            "food",
  find_nightlife:       "nightlife",
  plan_day:             "activity",
  fill_free_time:       "activity",
  create_meetup_draft:  "social",
  fix_schedule_conflict:"planning",
  what_is_missing:      "planning",
  add_to_plan:          "activity",
};

/* ── Intent types ── */
export type TelegraphIntent =
  | "plan_day"
  | "find_food"
  | "find_nightlife"
  | "create_meetup_draft"
  | "fill_free_time"
  | "fix_schedule_conflict"
  | "what_is_missing"
  | "add_to_plan"
  | "unknown";

export interface ProposedAction {
  id: string;
  label: string;
  kind: "add_to_plan" | "create_meetup" | "open_poll" | "ask_followup";
  params: Record<string, string>;
  requires_confirmation: true;
}

export interface TelegraphCommandResponse {
  commandId: string;
  intent: TelegraphIntent;
  summary: string;
  suggestions: Array<{
    title: string;
    reason: string;
    category: string;
    estimatedTime: string;
    priceLevel: string;
  }>;
  proposedActions: ProposedAction[];
  accessLevel: string;
  tripId: string | null;
  createdAt: string;
}

/* ── In-memory command store ──────────────────────────────────────────────────
 * Each entry includes the owner's userId so cross-user lookups are rejected.
 * Replace with DB persistence if commands need to survive server restart.
 */
const commandStore = new Map<string, TelegraphCommandResponse & { _userId: string }>();

function genId(): string {
  return `cmd_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

/* ── Intent parser ── */
export function parseIntent(text: string): TelegraphIntent {
  const t = text.toLowerCase();
  const word = (w: string) => new RegExp(`\\b${w}\\b`).test(t);
  if (t.includes("meetup") || t.includes("meet up")) return "create_meetup_draft";
  if (t.includes("plan") && (t.includes("day") || t.includes("today") || t.includes("tonight"))) return "plan_day";
  if (t.includes("conflict") || t.includes("overlap") || t.includes("clash") || t.includes("fix schedule")) return "fix_schedule_conflict";
  if (t.includes("free time") || t.includes("fill") || t.includes("gap") || t.includes("empty")) return "fill_free_time";
  if (t.includes("nightlife") || t.includes("bar") || t.includes("club") || t.includes("night out")) return "find_nightlife";
  if (word("food") || word("eat") || word("eating") || t.includes("restaurant") || t.includes("lunch") || t.includes("dinner") || t.includes("breakfast")) return "find_food";
  if (t.includes("missing") || t.includes("what else") || t.includes("what am i")) return "what_is_missing";
  if (t.includes("add") && t.includes("plan")) return "add_to_plan";
  return "unknown";
}

function buildResponse(
  commandId: string,
  intent: TelegraphIntent,
  userText: string,
  tripId: string | null,
  accessLevel: string,
  destination?: string,
  meetupContext?: { meetupId?: string; meetupTime?: string; meetupLocation?: string },
  nearbyVenues?: NearbyVenue[],
): TelegraphCommandResponse {
  // Build meetup-aware context for food suggestions
  const hasMeetupCtx = !!meetupContext?.meetupId;
  const meetupTimeStr = meetupContext?.meetupTime ? formatMeetupTime(meetupContext.meetupTime) : "";
  const meetupLoc = meetupContext?.meetupLocation ?? null;
  const nearbyRef = meetupLoc
    ? ` near ${meetupLoc}`
    : destination
      ? ` in ${destination}`
      : "";
  const timeRef = meetupTimeStr ? ` at ${meetupTimeStr}` : "";
  const meal = getMealLabel(meetupContext?.meetupTime);

  const mealCap = meal === "breakfast" ? "Breakfast" : meal === "lunch" ? "Lunch" : "Dinner";
  const hasRealVenues = nearbyVenues && nearbyVenues.length > 0;

  const findFoodSummary = hasMeetupCtx
    ? `${mealCap} options${nearbyRef}${timeRef}, before your meetup. Tap to add one to your plan.`
    : `Food recommendations${destination ? ` for ${destination}` : ""}. Tap to add to your trip plan.`;

  const mealVenueLabel = meal === "breakfast" ? "café or bakery" : meal === "lunch" ? "café or bistro" : "restaurant";
  const mealEstimate   = meal === "breakfast" ? "30–45 min" : meal === "lunch" ? "45 min–1 hour" : "1–1.5 hours";

  // Build suggestions from real venue data when available; fall back to templates
  const buildVenueSuggestions = (venues: NearbyVenue[]): TelegraphCommandResponse["suggestions"] =>
    venues.map((v) => ({
      title: v.name,
      reason: [
        formatDistance(v.distanceM),
        v.cuisine,
        meetupLoc ? `— easy to reach before your meetup` : null,
      ]
        .filter(Boolean)
        .join(" · "),
      category: "food",
      estimatedTime: v.priceLevel === "$" ? "30–45 min" : "45 min–1 hour",
      priceLevel: v.priceLevel,
    }));

  const findFoodSuggestions: TelegraphCommandResponse["suggestions"] = hasRealVenues
    ? buildVenueSuggestions(nearbyVenues!)
    : hasMeetupCtx
      ? [
          {
            title: `${mealCap} spot${nearbyRef}`,
            reason: meetupLoc
              ? `Close to ${meetupLoc} — easy to reach before your meetup`
              : `Good option before your meetup${timeRef}`,
            category: "food",
            estimatedTime: mealEstimate,
            priceLevel: "$$",
          },
          {
            title: "Quick pre-meetup bite",
            reason: `Something light and fast so you're ready${timeRef}`,
            category: "food",
            estimatedTime: "30–45 min",
            priceLevel: "$",
          },
          {
            title: `Local ${mealVenueLabel}${nearbyRef}`,
            reason: "Traveler favourite for the area",
            category: "food",
            estimatedTime: "1 hour",
            priceLevel: "$$",
          },
        ]
      : [
          { title: "Local street food market", reason: "Authentic flavours at budget prices", category: "food", estimatedTime: "1–2 hours", priceLevel: "$" },
          { title: "Highly-rated restaurant nearby", reason: "Traveler favourite for the area", category: "food", estimatedTime: "1–1.5 hours", priceLevel: "$$" },
          { title: "Late-night food spots", reason: "Great for after-activities eating", category: "food", estimatedTime: "45 min", priceLevel: "$" },
        ];

  const templates: Record<TelegraphIntent, { summary: string; suggestions: TelegraphCommandResponse["suggestions"]; actions: ProposedAction[] }> = {
    plan_day: {
      summary: `Here's a suggested plan for today${destination ? ` in ${destination}` : ""}. Tap any action to add it to your trip or create a meetup.`,
      suggestions: [
        { title: "Morning beach or market visit", reason: "Best time for beach or local market before the crowd", category: "beach", estimatedTime: "2–3 hours", priceLevel: "$" },
        { title: "Lunch at a local favourite", reason: "Midday fuel with local flavour", category: "food", estimatedTime: "1 hour", priceLevel: "$$" },
        { title: "Evening activity or nightlife", reason: "Wind down the day with the city's evening scene", category: "nightlife", estimatedTime: "2–4 hours", priceLevel: "$$" },
      ],
      actions: [
        { id: `${commandId}_a1`, label: "Add morning to plan", kind: "add_to_plan", params: { title: "Morning beach visit" }, requires_confirmation: true },
        { id: `${commandId}_a2`, label: "Create a meetup for this", kind: "create_meetup", params: { title: "Day plan meetup" }, requires_confirmation: true },
      ],
    },
    find_food: {
      summary: findFoodSummary,
      suggestions: findFoodSuggestions,
      actions: [
        {
          id: `${commandId}_a1`,
          label: "Add to plan",
          kind: "add_to_plan",
          params: hasMeetupCtx && meetupContext?.meetupId
            ? { category: "dining", meetupId: meetupContext.meetupId }
            : { category: "dining" },
          requires_confirmation: true,
        },
      ],
    },
    find_nightlife: {
      summary: `Nightlife picks${destination ? ` for ${destination}` : ""}. Confirm before adding to your plan.`,
      suggestions: [
        { title: "Rooftop bar with views", reason: "Popular evening spot with great atmosphere", category: "nightlife", estimatedTime: "2–3 hours", priceLevel: "$$" },
        { title: "Live music venue", reason: "Local bands, authentic night out", category: "nightlife", estimatedTime: "3–4 hours", priceLevel: "$$" },
        { title: "Night market walk", reason: "Street food meets social scene", category: "nightlife", estimatedTime: "1–2 hours", priceLevel: "$" },
      ],
      actions: [
        { id: `${commandId}_a1`, label: "Add nightlife to plan", kind: "add_to_plan", params: { category: "activity" }, requires_confirmation: true },
        { id: `${commandId}_a2`, label: "Create a meetup for tonight", kind: "create_meetup", params: { title: "Tonight's meetup" }, requires_confirmation: true },
      ],
    },
    create_meetup_draft: {
      summary: "I've drafted a meetup. Review the details and confirm to create it — nothing will be saved until you confirm.",
      suggestions: [],
      actions: [
        { id: `${commandId}_a1`, label: "Create meetup", kind: "create_meetup", params: { title: "Trip meetup" }, requires_confirmation: true },
      ],
    },
    fill_free_time: {
      summary: `Suggestions to fill your free windows${destination ? ` in ${destination}` : ""}. Confirm to add any to your plan.`,
      suggestions: [
        { title: "Hidden gem nearby", reason: "Off-the-beaten-path spot during your free window", category: "activity", estimatedTime: "1–2 hours", priceLevel: "$" },
        { title: "Local experience", reason: "Something unique to the destination", category: "culture", estimatedTime: "1.5 hours", priceLevel: "$$" },
      ],
      actions: [
        { id: `${commandId}_a1`, label: "Add to free window", kind: "add_to_plan", params: { category: "activity" }, requires_confirmation: true },
      ],
    },
    fix_schedule_conflict: {
      summary: "I found a time conflict in your plan. Here's how to resolve it — confirm before any changes are made.",
      suggestions: [],
      actions: [
        { id: `${commandId}_a1`, label: "Reschedule conflicting item", kind: "add_to_plan", params: { action: "reschedule" }, requires_confirmation: true },
        { id: `${commandId}_a2`, label: "Create a poll to decide", kind: "open_poll", params: { context: "conflict_resolution" }, requires_confirmation: true },
      ],
    },
    what_is_missing: {
      summary: "Based on your plan, here's what Telegraph suggests adding to make it complete.",
      suggestions: [
        { title: "Airport transfer or transport plan", reason: "No transport item found in your plan", category: "transport", estimatedTime: "variable", priceLevel: "$" },
        { title: "Accommodation check-in reminder", reason: "No accommodation entry found", category: "accommodation", estimatedTime: "30 min", priceLevel: "$$$$" },
      ],
      actions: [
        { id: `${commandId}_a1`, label: "Add missing items", kind: "add_to_plan", params: { category: "transport" }, requires_confirmation: true },
      ],
    },
    add_to_plan: {
      summary: "Tap confirm to add the suggested item to your trip plan.",
      suggestions: [],
      actions: [
        { id: `${commandId}_a1`, label: "Confirm add to plan", kind: "add_to_plan", params: { title: userText.slice(0, 80) }, requires_confirmation: true },
      ],
    },
    unknown: {
      summary: "I'm not sure what you're asking. Try: 'Plan tonight', 'Find food', 'Fill free time', 'Fix conflicts', or 'Create a meetup'.",
      suggestions: [],
      actions: [
        { id: `${commandId}_a1`, label: "Ask Telegraph something else", kind: "ask_followup", params: {}, requires_confirmation: true },
      ],
    },
  };

  const tpl = templates[intent];
  return {
    commandId,
    intent,
    summary: tpl.summary,
    suggestions: tpl.suggestions,
    proposedActions: tpl.actions,
    accessLevel,
    tripId,
    createdAt: new Date().toISOString(),
  };
}

/** Format an ISO datetime string to a human-readable time like "7:30 PM". */
function formatMeetupTime(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true });
  } catch {
    return "";
  }
}

/** Return the appropriate meal label based on the meetup hour. */
function getMealLabel(iso?: string): "breakfast" | "lunch" | "dinner" {
  if (!iso) return "dinner";
  try {
    const h = new Date(iso).getHours();
    if (h >= 7 && h < 11) return "breakfast";
    if (h >= 11 && h < 14) return "lunch";
    return "dinner";
  } catch {
    return "dinner";
  }
}

const CommandSchema = z.object({
  text:          z.string().min(1).max(500),
  tripId:        z.string().optional().nullable(),
  destination:   z.string().max(100).optional(),
  /** Structured meetup context forwarded from the Daily Brief "Find dinner nearby" quick action. */
  meetupId:      z.string().max(36).optional(),
  meetupTime:    z.string().max(50).optional(),
  meetupLocation: z.string().max(200).optional(),
});

/* ===========================================================================
 * POST /telegraph/commands
 * ===========================================================================
 */
router.post("/telegraph/commands", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { client, user } = auth;

  const parsed = CommandSchema.safeParse(req.body);
  if (!parsed.success) { sendError(res, "invalid_payload", parsed.error.issues[0]?.message ?? "Invalid body"); return; }
  const { text, tripId, destination, meetupId, meetupTime, meetupLocation } = parsed.data;

  let accessLevel = "partial";
  if (tripId && UUID.test(tripId)) {
    const verdict = await resolveContext(client, user.id, tripId);
    accessLevel = verdict.access;
    if (verdict.access === "unauthenticated") { sendError(res, "unauthenticated", "Not authenticated"); return; }
  }

  const commandId = genId();
  const intent = parseIntent(text);
  const meetupContext = meetupId ? { meetupId, meetupTime, meetupLocation } : undefined;

  // Fetch real nearby venues from OSM when the intent is food-related and a location is known.
  // Best-effort — never blocks the response; falls back to templates on any error.
  let nearbyVenues: NearbyVenue[] | undefined;
  if (intent === "find_food") {
    const lookupLocation = meetupLocation ?? destination;
    if (lookupLocation) {
      nearbyVenues = await getNearbyVenues(lookupLocation).catch(() => undefined);
    }
  }

  const response = buildResponse(commandId, intent, text, tripId ?? null, accessLevel, destination, meetupContext, nearbyVenues);

  // Store with owner userId — cross-user access rejected on all reads
  commandStore.set(commandId, { ...response, _userId: user.id });

  // Return public shape (without internal _userId field)
  const { _userId: _omit, ...publicResponse } = commandStore.get(commandId)!;
  res.status(201).json(intent === "unknown" ? { ...publicResponse, suggestions: [] } : publicResponse);
});

/* ===========================================================================
 * GET /telegraph/commands/:commandId
 * Returns stored command; 403 if owned by a different user.
 * ===========================================================================
 */
router.get("/telegraph/commands/:commandId", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const { commandId } = req.params;
  const stored = commandStore.get(commandId);
  if (!stored) { sendError(res, "not_found", "Command not found"); return; }
  if (stored._userId !== user.id) { sendError(res, "not_member", "You do not own this command"); return; }

  const { _userId: _omit, ...cmd } = stored;
  res.json(cmd);
});

/* ===========================================================================
 * POST /telegraph/commands/:commandId/confirm-action
 * Ownership check + re-verify trip membership at execution time.
 * ===========================================================================
 */
router.post("/telegraph/commands/:commandId/confirm-action", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { client, user } = auth;

  const { commandId } = req.params;
  const stored = commandStore.get(commandId);
  if (!stored) { sendError(res, "not_found", "Command not found"); return; }
  if (stored._userId !== user.id) { sendError(res, "not_member", "You do not own this command"); return; }

  const ActionSchema = z.object({ actionId: z.string() });
  const parsed = ActionSchema.safeParse(req.body);
  if (!parsed.success) { sendError(res, "invalid_payload", "actionId required"); return; }
  const { actionId } = parsed.data;

  const action = stored.proposedActions.find((a) => a.id === actionId);
  if (!action) { sendError(res, "not_found", `Action ${actionId} not found`); return; }

  /* ── §30A.10, through the registry rather than inline ──────────────────────
   * Every executable action registers authorize / preview / execute / optional
   * compensate. An action kind with no registration is REFUSED here rather than
   * confirmed with three of the four hooks silently skipped — which is what a
   * fifth kind added to buildResponse used to get.
   */
  const registration = registrationFor(action.kind);
  if (!registration) {
    cmdLogger.error({ commandId, kind: action.kind }, "unregistered executable action");
    sendError(
      res,
      "invalid_payload",
      `Action kind '${action.kind}' is not registered in TELEGRAPH_ACTION_REGISTRY, so its ` +
        "authorize / preview / execute / compensate behaviour is undefined. It cannot be confirmed.",
    );
    return;
  }

  const ctx: ActionContext = {
    client,
    userId: user.id,
    tripId: stored.tripId && UUID.test(stored.tripId) ? stored.tripId : null,
    commandId,
    actionId,
    label: action.label,
    params: action.params,
    category: (action.params.category as string | undefined) ?? INTENT_CATEGORY[stored.intent] ?? "unknown",
  };

  // AUTHORIZE — re-derived now, never taken from the card (§30A.11).
  const authorization = await registration.authorize(ctx);
  if (!authorization.authorized) {
    sendError(res, "not_member", authorization.reason);
    return;
  }

  // PREVIEW — what the person is confirming, in words, returned so a client
  // cannot render its own guess at it.
  const preview = registration.preview(ctx);

  // EXECUTE — the one write Telegraph is entitled to. The canonical write
  // belongs to `registration.canonicalOwner` and is not performed here.
  const execution = await registration.execute(ctx);
  if (execution.degraded) {
    cmdLogger.warn({ commandId, degraded: execution.degraded }, "orchestration record did not land");
  }

  /* §30A.11: "Current source-domain capability is rechecked at execution time
   * so expired events, revoked invitations, changed bookings, and removed
   * memberships fail safely." The recheck is AFTER the write, because a check
   * before it proves nothing about the instant after it — the same window
   * `services/telegraph/unsend.ts` compensates for. If it fails, COMPENSATE
   * removes the record and the caller is told, rather than being handed a
   * confirmation nothing backs.
   */
  const recheck = await registration.authorize(ctx);
  if (!recheck.authorized) {
    const compensation = await compensateFor(registration, ctx, execution);
    cmdLogger.warn(
      { commandId, actionId, undone: compensation.undone },
      "post-write recheck failed; orchestration record compensated",
    );
    res.status(409).json({
      error: "conflict",
      message:
        "Your authorization for this action changed while it was being confirmed, so nothing was kept. " +
        recheck.reason,
      commandId,
      actionId,
      confirmed: false,
      compensated: true,
      compensation,
    });
    return;
  }

  res.json({
    ok: true,
    commandId,
    actionId,
    kind: action.kind,
    params: action.params,
    confirmed: true,
    message: `Action '${action.label}' confirmed. Proceeding…`,
    /**
     * §30A.10 made visible to a reader of the API rather than only to a reader
     * of this file: which hooks ran, what was previewed, and WHO retains the
     * canonical truth — which is never Telegraph.
     */
    orchestration: {
      hooks: ["authorize", "preview", "execute", "compensate"],
      authorized: true,
      authorizationReason: authorization.reason,
      preview,
      canonicalOwner: registration.canonicalOwner,
      recorded: execution.recorded,
      recordDegraded: execution.degraded,
      compensated: false,
    },
  });
});

/* ===========================================================================
 * POST /telegraph/commands/:commandId/decline-action
 * Ownership check before allowing decline.
 * ===========================================================================
 */
router.post("/telegraph/commands/:commandId/decline-action", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const { commandId } = req.params;
  const stored = commandStore.get(commandId);
  if (!stored) { sendError(res, "not_found", "Command not found"); return; }
  if (stored._userId !== user.id) { sendError(res, "not_member", "You do not own this command"); return; }

  res.json({ ok: true, commandId, declined: true });
});

/* ===========================================================================
 * GET /trips/:tripId/telegraph/commands/history
 * Returns trip-scoped commands belonging to the requesting user only.
 * ===========================================================================
 */
router.get("/trips/:tripId/telegraph/commands/history", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { client, user } = auth;

  const { tripId } = req.params;
  if (!UUID.test(tripId)) { sendError(res, "invalid_payload", "Invalid tripId"); return; }

  const member = await isAcceptedTripMember(client, tripId, user.id);
  if (!member) { sendError(res, "not_member", "You must be an accepted trip member to view command history"); return; }

  const history = Array.from(commandStore.values())
    .filter((c) => c.tripId === tripId && c._userId === user.id)
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    .slice(0, 20)
    .map(({ _userId: _omit, ...cmd }) => cmd);

  res.json({ tripId, history });
});

export default router;
