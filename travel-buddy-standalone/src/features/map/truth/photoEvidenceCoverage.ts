/**
 * photoEvidenceCoverage — may the §22 sheet OFFER the photo/video step?
 *
 * The server keeps a map photo only when the contributor's recorded consent
 * disclosure names photos (Gate 2b, artifacts/api-server/src/lib/
 * intelEvidenceCapture.ts), and no disclosure in force does. The refusal (409
 * `consent_does_not_cover_photos`) arrives only at the attach, and the client
 * uploads the bytes BEFORE the attach (POST /api/media/upload). Offering the
 * step anyway therefore stored an object that nothing references and account
 * deletion never finds, and then told the person "Try attaching it again".
 *
 * So the sheet offers the step only when the server has said, for THIS
 * account, that a photo would be kept: GET /v1/intel/consent carries
 * `coversPhotoEvidence`, computed by the gate's own predicate. This module
 * reads that answer and nothing else. It never derives coverage from a
 * version string on the device: which words name photos is the server's list.
 *
 * FAIL-CLOSED. False, absent (an older server), a non-boolean, no state (an
 * unreadable or unconfigured read), a disabled or withdrawn grant: no photo
 * step, and so no upload.
 *
 * PURE. No I/O.
 */

/** The consent fields this module reads, structurally, so it imports no service. */
export interface PhotoCoverageView {
  enabled?: unknown;
  withdrawnAt?: unknown;
  coversPhotoEvidence?: unknown;
}

/** Offer the photo/video step? Only on the server's explicit `true` for a live grant. */
export function photoStepOffered(state: PhotoCoverageView | null | undefined): boolean {
  if (!state) return false;
  if (state.enabled !== true) return false;
  if (state.withdrawnAt !== null && state.withdrawnAt !== undefined) return false;
  return state.coversPhotoEvidence === true;
}
