/**
 * §2 MemoryNarrativeService over HTTP — the OWNER's summary of one of their
 * Memories, deterministic by default, with an optional AI draft behind a flag,
 * a separate opt-in and the owner's own controls.
 * census-highlights-memories H14, H172, H265 (B58 cluster MEM-NARR-1).
 *
 *   GET    /memories/:id/narrative          the deterministic summary (always),
 *                                           and whether an AI draft is on offer
 *   POST   /memories/:id/narrative/ai       an AI draft checked against the facts
 *                                           it was built from, or the
 *                                           deterministic summary and the reason
 *   GET    /me/memory-narrative-ai-consent  the caller's opt-in and the disclosure
 *   PUT    /me/memory-narrative-ai-consent  { enabled, disclosureVersion } — a grant
 *                                           needs the flag and the displayed
 *                                           version; withdrawing always works
 *   DELETE /me/memory-narrative-ai-consent  withdraw
 *
 * OWNER ONLY. Someone else's Memory, a missing one and a deleted one are the same
 * 404. A failed read is a 503, never a summary that reads as "nothing here"
 * (§28.11).
 *
 * READ-ONLY OVER MEMORIES. No route here writes a Memory or stores a summary:
 * a summary is an editable DRAFT, and using it as a caption is the owner's own
 * PATCH /memories/:id (§28.4 "never let AI prose write canonical historical
 * facts directly"). The one write is the caller's own consent row.
 *
 * Mounted from routes/index.ts on an existing line (that file is cited by line).
 */
import { Router, type Request, type Response } from "express";
import { requireUser, sendError } from "../lib/http.js";
import { getServiceClient } from "../lib/supabase.js";
import { asyncHandler } from "../lib/asyncHandler.js";
import { checkRateLimit } from "../lib/rateLimit.js";
import type { InputConsentState } from "../lib/inputAssistance/inputConsent.js";
import {
  MEMORY_NARRATIVE_AI_DISCLOSURE_TEXT,
  MEMORY_NARRATIVE_AI_DISCLOSURE_VERSION,
} from "../services/memory/memoryNarrative.js";
import {
  deterministicNarrativeOf,
  displayedNarrativeDisclosureMatches,
  draftAiNarrative,
  loadOwnerNarrativeSource,
  narrativeAiConsentValid,
  narrativeAiControls,
  narrativeAiGate,
  readNarrativeAiConsent,
  readNarrativeAiFlag,
  writeNarrativeAiConsent,
} from "../services/memory/memoryNarrativeService.js";
import type { MemoryResurfacingControl } from "../services/memory/memoryResurfacingControls.js";

const router = Router();
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The words the owner set, for the refusal that names them. */
const CONTROL_LABEL: Readonly<Record<MemoryResurfacingControl, string>> = Object.freeze({
  DO_NOT_RESURFACE: "Don't resurface",
  DO_NOT_INCLUDE_IN_RECAPS: "Don't include in recaps",
  KEEP_PRIVATE_FOREVER: "Keep private forever",
  RETAIN_BUT_DO_NOT_PERSONALIZE: "Don't use for personalization",
});

function controlsRefusal(res: Response, controls: MemoryResurfacingControl[]): void {
  const names = controls.map((c) => `“${CONTROL_LABEL[c]}”`).join(" and ");
  res.status(403).json({
    error: "forbidden",
    reason: "excluded_by_control",
    controls,
    message: `This Memory is set to ${names}, so it is not sent to the AI. You can change that in the Memory's settings.`,
  });
}

// ── GET /memories/:id/narrative ───────────────────────────────────────────────

router.get("/memories/:id/narrative", asyncHandler(async (req: Request, res: Response) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const id = String(req.params.id ?? "");
  if (!UUID_RE.test(id)) { sendError(res, "not_found", "Memory not found"); return; }
  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  const source = await loadOwnerNarrativeSource(sc, id, auth.user.id);
  if (source.state === "not_found") { sendError(res, "not_found", "Memory not found"); return; }
  if (source.state === "unreadable") {
    req.log.error({ detail: source.detail }, "memory narrative: source unreadable — refusing rather than summarizing a partial read");
    sendError(res, "degraded_unavailable", "This Memory could not be summarized right now. Please try again.");
    return;
  }
  // The offer is advisory: the POST re-checks every gate. A gate that could not
  // be read only withdraws the offer; it never withholds the deterministic summary.
  const gate = await narrativeAiGate(sc, auth.user.id, id);
  res.json({
    narrative: deterministicNarrativeOf(source),
    ai: gate.open
      ? { available: true, reason: null }
      : { available: false, reason: gate.reason, ...(gate.reason === "excluded_by_control" ? { controls: gate.controls } : {}) },
  });
}));

// ── POST /memories/:id/narrative/ai ───────────────────────────────────────────

router.post("/memories/:id/narrative/ai", asyncHandler(async (req: Request, res: Response) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const id = String(req.params.id ?? "");
  if (!UUID_RE.test(id)) { sendError(res, "not_found", "Memory not found"); return; }
  const rl = checkRateLimit("memory_narrative_ai", auth.user.id, 10, 60_000);
  if (!rl.allowed) {
    res.setHeader("Retry-After", Math.ceil(rl.retryAfterMs / 1000).toString());
    sendError(res, "rate_limited", "Too many summaries. Please wait a moment.");
    return;
  }
  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  // 1. The flag. Dark means no further database contact and no model call.
  const flag = await readNarrativeAiFlag(sc);
  if (flag === "off") { sendError(res, "feature_disabled", "AI summaries are not available."); return; }
  if (flag === "unreadable") { sendError(res, "degraded_unavailable", "AI summaries could not be checked right now. Please try again."); return; }

  // 2. The caller's own opt-in, for this purpose only.
  const consent = await readNarrativeAiConsent(sc, auth.user.id);
  if (!consent.ok) { sendError(res, "degraded_unavailable", "Your AI summary setting could not be read. Please try again."); return; }
  if (!narrativeAiConsentValid(consent.state)) {
    sendError(res, "forbidden", "Turn on AI summaries first.", { exposeDetail: true, reason: "consent_required" });
    return;
  }

  // 3. The Memory — theirs, readable.
  const source = await loadOwnerNarrativeSource(sc, id, auth.user.id);
  if (source.state === "not_found") { sendError(res, "not_found", "Memory not found"); return; }
  if (source.state === "unreadable") {
    req.log.error({ detail: source.detail }, "memory narrative ai: source unreadable");
    sendError(res, "degraded_unavailable", "This Memory could not be summarized right now. Please try again.");
    return;
  }

  // 4. The owner's controls on THIS Memory.
  const controls = await narrativeAiControls(sc, auth.user.id, id);
  if (controls.state === "unreadable") {
    req.log.error({ detail: controls.detail }, "memory narrative ai: controls unreadable — nothing is sent to the model");
    sendError(res, "degraded_unavailable", "This Memory's privacy settings could not be checked, so nothing was sent. Please try again.");
    return;
  }
  if (controls.state === "excluded") { controlsRefusal(res, controls.controls); return; }

  const out = await draftAiNarrative(source);
  if (!out.accepted) {
    // The reason only: the draft and the facts are never logged.
    if (out.fallback_reason === "model_unavailable") req.log.warn({ reason: out.fallback_reason }, "memory narrative ai: model call failed — serving the deterministic summary");
    else req.log.info({ reason: out.fallback_reason }, "memory narrative ai: draft refused by the fact check — serving the deterministic summary");
    res.json({ accepted: false, fallback_reason: out.fallback_reason, narrative: out.deterministic, deterministic: out.deterministic });
    return;
  }
  res.json({ accepted: true, fallback_reason: null, narrative: out.narrative, deterministic: out.deterministic });
}));

// ── The opt-in ────────────────────────────────────────────────────────────────

function consentBody(state: InputConsentState | null, available: boolean) {
  return {
    available,
    enabled: narrativeAiConsentValid(state),
    consentVersion: state?.consentVersion ?? null,
    consentedAt: state?.consentedAt ?? null,
    withdrawnAt: state?.withdrawnAt ?? null,
    currentDisclosureVersion: MEMORY_NARRATIVE_AI_DISCLOSURE_VERSION,
    // ENGINEERING DRAFT — legal review before memory_narrative_ai_enabled is turned on (Q-NARR-6).
    disclosureText: MEMORY_NARRATIVE_AI_DISCLOSURE_TEXT,
  };
}

router.get("/me/memory-narrative-ai-consent", asyncHandler(async (req: Request, res: Response) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }
  const [flag, read] = await Promise.all([readNarrativeAiFlag(sc), readNarrativeAiConsent(sc, auth.user.id)]);
  if (!read.ok) { sendError(res, "degraded_unavailable", "Your setting could not be read. Please try again."); return; }
  res.json(consentBody(read.state, flag === "on"));
}));

async function recordConsent(req: Request, res: Response, userId: string, enabled: boolean, disclosureVersion: unknown): Promise<void> {
  const rl = checkRateLimit("memory_narrative_ai_consent", userId, 20, 60_000);
  if (!rl.allowed) {
    res.setHeader("Retry-After", Math.ceil(rl.retryAfterMs / 1000).toString());
    sendError(res, "rate_limited", "Too many changes. Please wait.");
    return;
  }
  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }
  const flag = await readNarrativeAiFlag(sc);
  if (enabled) {
    // A grant needs the feature to exist and the caller to have seen today's words.
    if (flag === "off") { sendError(res, "feature_disabled", "This setting is not available yet."); return; }
    if (flag === "unreadable") { sendError(res, "degraded_unavailable", "This setting could not be checked right now. Please try again."); return; }
    if (!displayedNarrativeDisclosureMatches(disclosureVersion)) {
      sendError(res, "conflict", "The explanation you saw is out of date. Please review it again.");
      return;
    }
  }
  // Withdrawing is accepted whatever the flag says.
  const write = await writeNarrativeAiConsent(sc, userId, enabled);
  if (!write.ok) {
    req.log.error({ enabled }, "memory narrative ai: consent write failed");
    sendError(res, "degraded_unavailable", "Your setting could not be saved. Please try again.");
    return;
  }
  res.json(consentBody(write.state, flag === "on"));
}

router.put("/me/memory-narrative-ai-consent", asyncHandler(async (req: Request, res: Response) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const body = (req.body ?? {}) as Record<string, unknown>;
  if (typeof body.enabled !== "boolean") { sendError(res, "invalid_payload", "enabled must be a boolean"); return; }
  await recordConsent(req, res, auth.user.id, body.enabled, body.disclosureVersion);
}));

router.delete("/me/memory-narrative-ai-consent", asyncHandler(async (req: Request, res: Response) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  await recordConsent(req, res, auth.user.id, false, undefined);
}));

export default router;
