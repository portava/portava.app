/**
 * Airport curation — the admin workflow (census-layover L14, L79, L80, L83,
 * L223, L247; owner decision 2026-10-18 "Build the required airport-data
 * curation and validation workflow"). LAYOVER 165, lane B2-CURATE.
 *
 *   GET  /admin/airport/profiles/:id/curation           history (every version), the projection, the maturity rung
 *   POST /admin/airport/profiles/:id/curation/facts     propose a fact (a NEW VERSION; quality preview returned)
 *   POST /admin/airport/curation/facts/:factId/validate a human curator validates: every quality check re-runs NOW
 *   POST /admin/airport/curation/facts/:factId/reject   { reason }
 *   POST /admin/airport/curation/facts/:factId/publish  airport_curation_publish (3874): supersede + project + topology_version
 *   POST /admin/airport/curation/facts/:factId/retract  { reason }
 *   POST /admin/airport/curation/packets                load a docs/ops/airport-curation packet as PROPOSALS only
 *   POST /admin/airport/profiles/:id/calibrate          recalibrate the time-of-day bands (3880) from measured error
 *
 * A SEPARATE ROUTER, like routes/layoverConstraints.ts, because routes/airport.ts
 * is line-anchored by census citations. Every route is admin-only
 * (`requireAdmin`, which answers 403 itself) and writes only through the
 * service client. Nothing here lets a fact reach a traveller without a named
 * curator's validation and an explicit publish.
 */
import { Router } from "express";
import { asyncHandler } from "../lib/asyncHandler.js";
import { sendError } from "../lib/http.js";
import { requireAdmin } from "../lib/requireAdmin.js";
import { airportRowToProfile } from "../services/airport/AirportProfileService.js";
import { landsideMaturityDecision } from "../services/airport/layoverMaturityGate.js";
import { matchRead, readDisclosure } from "../services/layover/layoverRead.js";
import { landsideMaturityInput } from "../services/airport/layoverMaturity.js";
import {
  importCurationPacket,
  isCurationPacket,
  proposeCuratedFact,
  publishValidatedFact,
  readCurationHistory,
  readCuratedFact,
  rejectCuratedFact,
  retractPublishedFact,
  validateProposedFact,
  type CurationRefusal,
} from "../services/airport/airportCuration.js";
import { recalibrateAirport } from "../services/airport/layoverCalibration.js";

const router = Router();
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function refusal(res: any, reason: CurationRefusal, message: string, report?: unknown): void {
  const status: Record<CurationRefusal, number> = {
    invalid_kind: 400, invalid_source: 400, invalid_expiry: 400, no_reason: 400,
    no_airport: 404, no_fact: 404,
    conflict: 409, not_proposed: 409, not_validated: 409, not_published: 409, expired: 409,
    quality_failed: 422,
    storage_unavailable: 503, read_failed: 503, write_failed: 503,
  };
  res.status(status[reason]).json({ error: reason, message, ...(report ? { report } : {}) });
}

router.get("/admin/airport/profiles/:id/curation", asyncHandler(async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  const { sc } = admin;
  if (!UUID_RE.test(req.params.id)) { sendError(res, "invalid_payload", "airport id must be a uuid"); return; }
  const { data: row, error } = await sc.from("airport_profiles").select("*").eq("id", req.params.id).maybeSingle();
  if (error) { sendError(res, "degraded_unavailable", "The airport could not be read."); return; }
  if (!row) { sendError(res, "not_found", "Airport profile not found"); return; }
  const history = await readCurationHistory(sc, req.params.id);
  if (!history.ok) { refusal(res, history.reason, history.message); return; }
  const nowMs = Date.now();
  const profile = airportRowToProfile(row);
  const maturityRead = await landsideMaturityDecision(sc, profile, nowMs);
  const decision = matchRead(maturityRead, { read: (value) => value, degraded: (fallback) => fallback });
  res.json({
    airport: { id: profile.id, iataCode: profile.iataCode, name: profile.name, factsProvenance: (row as any).facts_provenance ?? "unvalidated_no_provenance" },
    projection: profile.curation,
    maturity: { level: decision.level, cappedBy: decision.cappedBy, landsideAllowed: decision.allowed, landsideInput: landsideMaturityInput(profile, nowMs) ?? null, observationCount: decision.observationCount, signalsReadable: decision.signalsReadable, ...readDisclosure(maturityRead) },
    facts: history.facts,
  });
}));

router.post("/admin/airport/profiles/:id/curation/facts", asyncHandler(async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  const { sc, userId } = admin;
  if (!UUID_RE.test(req.params.id)) { sendError(res, "invalid_payload", "airport id must be a uuid"); return; }
  const body = (req.body ?? {}) as Record<string, any>;
  const r = await proposeCuratedFact(sc, {
    airportId: req.params.id, kind: body.kind, value: body.value, source: body.source ?? {}, expiresAt: body.expiresAt,
    proposedVia: "admin", proposedBy: userId,
  }, Date.now());
  if (!r.ok) { refusal(res, r.reason, r.message, r.report); return; }
  res.status(201).json({ ok: true, fact: r.fact, preview: r.preview });
}));

router.post("/admin/airport/curation/facts/:factId/validate", asyncHandler(async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  if (!UUID_RE.test(req.params.factId)) { sendError(res, "invalid_payload", "fact id must be a uuid"); return; }
  const r = await validateProposedFact(admin.sc, req.params.factId, admin.userId, Date.now());
  if (!r.ok) { refusal(res, r.reason, r.message, r.report); return; }
  res.json({ ok: true, fact: r.fact, report: r.report });
}));

router.post("/admin/airport/curation/facts/:factId/reject", asyncHandler(async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  if (!UUID_RE.test(req.params.factId)) { sendError(res, "invalid_payload", "fact id must be a uuid"); return; }
  const r = await rejectCuratedFact(admin.sc, req.params.factId, admin.userId, req.body?.reason, Date.now());
  if (!r.ok) { refusal(res, r.reason, r.message); return; }
  res.json({ ok: true, fact: r.fact });
}));

router.post("/admin/airport/curation/facts/:factId/publish", asyncHandler(async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  if (!UUID_RE.test(req.params.factId)) { sendError(res, "invalid_payload", "fact id must be a uuid"); return; }
  const r = await publishValidatedFact(admin.sc, req.params.factId, admin.userId);
  if (!r.ok) { refusal(res, r.reason, r.message); return; }
  const fact = await readCuratedFact(admin.sc, req.params.factId);
  res.json({ ok: true, published: r.published, fact: fact.ok ? fact.fact : null });
}));

router.post("/admin/airport/curation/facts/:factId/retract", asyncHandler(async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  if (!UUID_RE.test(req.params.factId)) { sendError(res, "invalid_payload", "fact id must be a uuid"); return; }
  const r = await retractPublishedFact(admin.sc, req.params.factId, admin.userId, req.body?.reason);
  if (!r.ok) { refusal(res, r.reason, r.message); return; }
  res.json({ ok: true, retracted: r.retracted });
}));

router.post("/admin/airport/curation/packets", asyncHandler(async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  if (!isCurationPacket(req.body)) { sendError(res, "invalid_payload", "body must be a curation packet (packetVersion 1, iata, facts[])"); return; }
  const r = await importCurationPacket(admin.sc, req.body, admin.userId, Date.now());
  if (!r.ok) { refusal(res, r.reason, r.message); return; }
  res.status(201).json({ ok: true, airportId: r.airportId, state: "proposed_unvalidated", results: r.results });
}));

router.post("/admin/airport/profiles/:id/calibrate", asyncHandler(async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  const { sc } = admin;
  if (!UUID_RE.test(req.params.id)) { sendError(res, "invalid_payload", "airport id must be a uuid"); return; }
  const { data: row, error } = await sc.from("airport_profiles").select("id,iata_code,timezone").eq("id", req.params.id).maybeSingle();
  if (error) { sendError(res, "degraded_unavailable", "The airport could not be read."); return; }
  if (!row) { sendError(res, "not_found", "Airport profile not found"); return; }
  const r = await recalibrateAirport(sc, { id: String((row as any).id), iataCode: (row as any).iata_code ?? null, timezone: (row as any).timezone ?? "UTC" }, Date.now());
  if (!r.ok) { sendError(res, r.reason === "no_airport_ref" ? "invalid_payload" : "degraded_unavailable", r.message); return; }
  res.json(r);
}));

export default router;
