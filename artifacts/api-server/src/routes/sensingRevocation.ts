import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../lib/asyncHandler.js";
import { sendError } from "../lib/http.js";
import { getServiceClient } from "../lib/supabase.js";
import { sensingPepperPosture } from "../lib/sensingAnonService.js";
import { deriveContributorToken, deriveSensingCredentialHash, revocationCommitment, rotationEpochFor, SENSING_MAX_TTL_SECONDS, SENSING_ROTATION_PERIOD_SECONDS } from "../lib/sensingAnonStore.js";
import { readSensingCredential } from "./sensingIngest.js";

const router = Router();
const payload = z.object({ epochs: z.array(z.object({
  rotationEpoch: z.number().int().nonnegative(), epochSecret: z.string().regex(/^[a-f0-9]{64}$/i),
}).strict()).max(74) }).strict();

// Proof of an epoch preimage authorizes deletion. Account identity is neither
// accepted nor looked up, and the operational ingest flag never blocks erasure.
router.post('/v1/sensing/revoke', asyncHandler(async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (!sensingPepperPosture().ok) return sendError(res, 'server_not_configured', 'sensing deletion is unavailable');
  const parsed = payload.safeParse(req.body);
  if (!parsed.success) return sendError(res, 'invalid_payload', 'invalid sensing deletion proof');
  const current = rotationEpochFor(Date.now());
  const earliest = current - Math.ceil(SENSING_MAX_TTL_SECONDS / SENSING_ROTATION_PERIOD_SECONDS);
  if (parsed.data.epochs.some(proof => proof.rotationEpoch < earliest || proof.rotationEpoch > current)) {
    return sendError(res, 'invalid_payload', 'sensing deletion epoch is outside the retention window');
  }
  const credential = readSensingCredential(req);
  if (credential && (credential.length < 16 || credential.length > 256)) return sendError(res, 'invalid_payload', 'invalid sensing credential');
  const db = getServiceClient();
  if (!db) return sendError(res, 'server_not_configured', 'sensing deletion is unavailable');
  try {
    const {data, error} = await db.rpc('sensing_revoke_recent', {
      p_credential_hash: credential ? deriveSensingCredentialHash(credential) : null,
      p_epochs: parsed.data.epochs.map(proof => ({ rotationEpoch: proof.rotationEpoch,
        contributorToken: deriveContributorToken(proof.rotationEpoch, revocationCommitment(proof.epochSecret)) })),
    }).abortSignal(AbortSignal.timeout(6000));
    if (error || data !== true) return sendError(res, 'db_error', 'sensing deletion could not be confirmed; try again');
    return res.status(204).end();
  } catch {
    // Never log exceptions: transport errors can include the proof payload.
    return sendError(res, 'degraded_unavailable', 'sensing deletion could not be confirmed; try again');
  }
}));
export default router;
