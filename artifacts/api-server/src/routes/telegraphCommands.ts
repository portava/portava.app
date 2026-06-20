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
import { requireUser, sendError, isAcceptedTripMember } from "../lib/http.js";
import { resolveContext } from "../lib/privacyResolver.js";

const router = Router();

const UUID = /^[0-9a-f-]{36}$/i;

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
): TelegraphCommandResponse {
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
      summary: `Food recommendations${destination ? ` for ${destination}` : ""}. Tap to add to your trip plan.`,
      suggestions: [
        { title: "Local street food market", reason: "Authentic flavours at budget prices", category: "food", estimatedTime: "1–2 hours", priceLevel: "$" },
        { title: "Highly-rated restaurant nearby", reason: "Traveler favourite for the area", category: "food", estimatedTime: "1–1.5 hours", priceLevel: "$$" },
        { title: "Late-night food spots", reason: "Great for after-activities eating", category: "food", estimatedTime: "45 min", priceLevel: "$" },
      ],
      actions: [
        { id: `${commandId}_a1`, label: "Add to plan", kind: "add_to_plan", params: { category: "dining" }, requires_confirmation: true },
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

const CommandSchema = z.object({
  text:        z.string().min(1).max(500),
  tripId:      z.string().optional().nullable(),
  destination: z.string().max(100).optional(),
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
  const { text, tripId, destination } = parsed.data;

  let accessLevel = "partial";
  if (tripId && UUID.test(tripId)) {
    const verdict = await resolveContext(client, user.id, tripId);
    accessLevel = verdict.access;
    if (verdict.access === "unauthenticated") { sendError(res, "unauthenticated", "Not authenticated"); return; }
  }

  const commandId = genId();
  const intent = parseIntent(text);
  const response = buildResponse(commandId, intent, text, tripId ?? null, accessLevel, destination);

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

  // Re-verify trip membership at confirmation time
  if (stored.tripId && UUID.test(stored.tripId)) {
    const isMember = await isAcceptedTripMember(client, stored.tripId, user.id);
    if (!isMember) { sendError(res, "not_member", "You must be an accepted trip member to confirm this action"); return; }
  }

  res.json({
    ok: true,
    commandId,
    actionId,
    kind: action.kind,
    params: action.params,
    confirmed: true,
    message: `Action '${action.label}' confirmed. Proceeding…`,
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
