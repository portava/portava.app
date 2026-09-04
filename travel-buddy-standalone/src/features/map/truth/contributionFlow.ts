/**
 * contributionFlow — the §22 media contribution as the TWO calls §21 requires.
 *
 * WHY THIS MODULE EXISTS
 * ======================
 * Seven of §22's eight prompts are one call: the contributor states a
 * proposition and it becomes an observation. The eighth — "Current photo/video"
 * — cannot be, because §21 orders the pipeline
 *
 *     Observation -> Evidence -> Claim -> Confidence -> Freshness -> Correction
 *
 * and `intel_evidence.observation_id` is NOT NULL. A photo is EVIDENCE, not a
 * proposition: ask which claim a photo of a bar makes and there is no answer.
 * So it can only ever be attached to an observation that already exists, which
 * on the client means:
 *
 *     1. submit the proposition            -> the server returns its id
 *     2. upload the asset                  -> the app's media path returns a
 *                                             storage reference (EXIF stripped)
 *     3. submit the media contribution     -> carrying that observation id
 *
 * The server refuses a media contribution with no `observationId`, with the
 * ruling as the reason. This module does not work around that refusal; it is
 * the client half of the same rule.
 *
 * WHAT THIS MODULE IS
 * ===================
 * Pure. It performs no I/O of its own — every call goes through the injected
 * `ContributionTransport`, which the sheet fills with the app's EXISTING
 * services (`services/mapObservations.submitMapObservation` and
 * `services/media.uploadMedia`). There is no second uploader and no second
 * ingest path here; a duplicate would drift from the gates the real ones carry.
 * Being pure is also what makes the ORDER testable: a fake transport records
 * the calls and the test asserts the sequence, not merely that both happened.
 *
 * FOUR RULES IT EXISTS TO KEEP
 * ============================
 *   1. MEDIA MINTS NO CLAIM. Nothing here maps a media contribution to a claim
 *      type, and nothing adds `media` to a claim-type list. It is carried to
 *      the evidence arrow and nowhere else.
 *   2. NO COORDINATES. Nothing in the media leg reads, derives or forwards a
 *      location. EXIF/GPS is stripped at upload; this path never puts it back,
 *      and the only fields it sends are the ones §22's payload declares.
 *   3. EVIDENCE NEVER PRECEDES ITS OBSERVATION. `attachMediaEvidence` refuses
 *      an absent observation id BEFORE it uploads anything, so step 2 cannot
 *      run without step 1 having succeeded.
 *   4. A FAILED STEP 2 NEVER RETRIES STEP 1. The observation is already stored;
 *      re-running it would create a SECOND observation for one act. Retrying is
 *      `attachMediaEvidence` again with the same id — which is why the two legs
 *      are two functions and not one.
 */
import {
  CONTRIBUTION_PROMPT_LABELS,
  CONTRIBUTION_OPTIONS,
  createContribution,
  type ContributionCandidate,
  type MapContribution,
  type MapContributionKind,
  type MediaKind,
} from './liveTruth.ts';
import type { MapObject } from '../../../types/mapObjects.ts';

// ── Transport ─────────────────────────────────────────────────────────────────

/** What the server answers when a contribution was NOT rejected outright. */
export interface ContributionSubmitOk {
  ok: true;
  /** False when the capture flag is off: the tap was not an error, but nothing was stored. */
  enabled: boolean;
  /** 0 means nothing was recorded, whatever else the envelope says. */
  accepted: number;
  /** The observation's id — the only thing that can carry the media leg. */
  observationId?: string | null;
  /** The evidence row's id, on the media leg. */
  evidenceId?: string | null;
  /** True when the server recognised this as a replay of a contribution it already has. */
  deduped?: boolean;
}

/** A refusal (the server said no) or a transport failure. */
export interface ContributionSubmitRejected {
  ok: false;
  error: string;
  /** The server's stable error code when it answered at all; null on a network failure. */
  errorCode?: string | null;
}

export type ContributionSubmitResult = ContributionSubmitOk | ContributionSubmitRejected;

/**
 * One asset the contributor captured, in the shape the app's upload service
 * already takes. Deliberately NOT widened: there is no coordinate field here
 * and there must never be one — `intel_evidence` is not a second location
 * store, and the upload endpoint strips EXIF/GPS precisely so it cannot become
 * one.
 */
export interface MapMediaAsset {
  uri: string;
  mimeType?: string | null;
  fileSize?: number | null;
  type?: 'image' | 'video' | string | null;
  duration?: number | null;
}

/** What the app's upload path answers. Structurally `MediaUploadResult`. */
export interface MediaUploadOutcome {
  ok: boolean;
  /** The storage reference to send. NEVER the device URI that went in. */
  url?: string | null;
  message?: string | null;
  errorKind?: string | null;
}

/**
 * The two seams this module needs, both filled with services that already
 * exist. Injected rather than imported so the flow stays pure — and so a test
 * can record the ORDER the two contribution calls are made in.
 */
export interface ContributionTransport {
  /** POST one contribution to the §22 ingest. */
  submit: (contribution: MapContribution) => Promise<ContributionSubmitResult>;
  /**
   * Upload one asset through POST /api/media/upload (via `services/media`).
   * Returns the storage reference the ingest will accept.
   */
  upload: (asset: MapMediaAsset, kind: MediaKind) => Promise<MediaUploadOutcome>;
}

// ── Outcomes ──────────────────────────────────────────────────────────────────

/**
 * Why a leg did not land. Every value is a state the contributor is TOLD about
 * — none of them is a silent drop.
 */
export type ContributionFailureReason =
  /** The capture flag is off: nothing was stored, and that is not an error. */
  | 'not_enabled'
  /** The server understood and said no (consent, vocabulary, ownership, order). */
  | 'refused'
  /** The upload did not produce a reference we may send. */
  | 'upload_failed'
  /** The request never got an answer. */
  | 'transport_failed'
  /** The payload could not be built, so nothing was sent. */
  | 'not_constructible';

export type ObservationOutcome =
  | { ok: true; observationId: string; deduped: boolean }
  | { ok: false; reason: ContributionFailureReason; detail: string | null };

export type MediaEvidenceOutcome =
  | { ok: true; evidenceId: string | null; deduped: boolean }
  /** The contributor backed out of the picker. Nothing was sent; not a failure. */
  | { ok: false; reason: 'cancelled'; detail: null }
  | { ok: false; reason: ContributionFailureReason; detail: string | null };

/**
 * Read one submit result as an outcome.
 *
 * `accepted < 1` is treated as "not recorded" even when `ok` is true, which is
 * the fail-closed reading: the flag-off envelope is `{ ok: true, accepted: 0 }`
 * and rendering that as a success would tell the contributor their report
 * landed when nothing was written.
 */
function readSubmit(
  result: ContributionSubmitResult,
): { ok: true; result: ContributionSubmitOk } | { ok: false; reason: ContributionFailureReason; detail: string | null } {
  if (!result.ok) {
    // An error CODE means the server answered — it refused. No code means the
    // request never arrived, which is a different thing to tell someone.
    const refused = typeof result.errorCode === 'string' && result.errorCode !== '';
    return {
      ok: false,
      reason: refused ? 'refused' : 'transport_failed',
      detail: result.error || null,
    };
  }
  if (result.enabled === false || !(result.accepted >= 1)) {
    return { ok: false, reason: 'not_enabled', detail: null };
  }
  return { ok: true, result };
}

// ── Step 1 · the observation ──────────────────────────────────────────────────

/**
 * Submit the proposition the contributor made, and hand back its id.
 *
 * This is an ordinary §22 contribution — the same one the seven non-media
 * prompts send on their own. The media leg is what needs its id; nothing about
 * this call changes because a photo may follow.
 */
export async function submitObservation(
  contribution: MapContribution,
  transport: Pick<ContributionTransport, 'submit'>,
): Promise<ObservationOutcome> {
  const read = readSubmit(await transport.submit(contribution));
  if (!read.ok) return { ok: false, reason: read.reason, detail: read.detail };

  const observationId = read.result.observationId;
  if (typeof observationId !== 'string' || observationId.trim() === '') {
    // Accepted, but with no id to attach to. Reported as a refusal of the
    // EVIDENCE arrow rather than swallowed: the observation stands, and the
    // caller must not pretend it can hang a photo off nothing.
    return { ok: false, reason: 'refused', detail: 'The server recorded no observation id to attach media to.' };
  }
  return { ok: true, observationId, deduped: read.result.deduped === true };
}

// ── Step 2 · the evidence ─────────────────────────────────────────────────────

export interface MediaEvidenceInput {
  /** The object the observation was about. */
  object: (ContributionCandidate & Pick<MapObject, 'id'>) | null | undefined;
  /** The observation the artifact supports. Required — §21, and NOT NULL. */
  observationId: string | null | undefined;
  /** §22's asset type. */
  mediaKind: MediaKind;
  /** The captured asset, or null when the contributor backed out of the picker. */
  asset: MapMediaAsset | null | undefined;
  /** Injectable clock, matching `createContribution`. */
  now?: Date | number;
}

/**
 * Upload the asset and attach it to an observation that already exists.
 *
 * ORDER, top to bottom, and each step is a gate on the next:
 *
 *   1. refuse with no observation id — BEFORE the asset is touched, because a
 *      bare photo is not a §22 contribution no matter how good the file is;
 *   2. upload through the app's existing media path, which strips EXIF/GPS;
 *   3. build the payload from the RESULTING STORAGE REFERENCE — never the
 *      device URI, which the server would refuse as "not ours";
 *   4. submit it as the media contribution.
 *
 * Calling this a second time after a failure re-runs steps 2-4 ONLY. It has no
 * way to create an observation, so a retry cannot duplicate one.
 */
export async function attachMediaEvidence(
  input: MediaEvidenceInput,
  transport: ContributionTransport,
): Promise<MediaEvidenceOutcome> {
  const observationId = input.observationId;
  if (typeof observationId !== 'string' || observationId.trim() === '') {
    // §21's order, enforced before anything is spent on the asset.
    return {
      ok: false,
      reason: 'not_constructible',
      detail: 'A photo attaches to an observation. There is no observation to attach it to.',
    };
  }
  if (!input.asset || typeof input.asset.uri !== 'string' || input.asset.uri.trim() === '') {
    return { ok: false, reason: 'cancelled', detail: null };
  }

  const uploaded = await transport.upload(input.asset, input.mediaKind);
  const reference = uploaded.url;
  if (!uploaded.ok || typeof reference !== 'string' || reference.trim() === '') {
    return {
      ok: false,
      reason: 'upload_failed',
      detail: uploaded.message || null,
    };
  }

  // The payload carries the STORAGE REFERENCE the upload returned. The device
  // URI does not travel: the server only accepts an object it can prove is ours
  // and this contributor's, and a `file://` path is neither.
  const contribution = createContribution(input.object, 'media', input.mediaKind, {
    now: input.now,
    mediaUri: reference,
    observationId,
  });
  if (!contribution) {
    return {
      ok: false,
      reason: 'not_constructible',
      detail: 'This is not something a photo can be attached to.',
    };
  }

  const read = readSubmit(await transport.submit(contribution));
  if (!read.ok) return { ok: false, reason: read.reason, detail: read.detail };
  return { ok: true, evidenceId: read.result.evidenceId ?? null, deduped: read.result.deduped === true };
}

// ── What the contributor reads ────────────────────────────────────────────────

/**
 * The phases of one act. `observed` and everything after it mean an observation
 * EXISTS — which is why every failure from `attaching` onward says so.
 */
export type ContributionFlowPhase =
  | 'submitting'
  | 'observed'
  | 'observation_failed'
  | 'attaching'
  | 'attached'
  | 'attach_failed';

export interface ContributionFlowState {
  phase: ContributionFlowPhase;
  /** Non-null from `observed` onward. The retry path's proof that step 1 is done. */
  observationId: string | null;
  /** The proposition, echoed so the contributor can see what the photo supports. */
  answer: string;
  /** The one line the sheet shows. Never optimistic. */
  status: string;
  /** The server's own words, when it gave any. */
  detail: string | null;
  /** True while a request is in flight: the sheet takes no new taps. */
  busy: boolean;
  /** Which leg a retry would re-run. NEVER 'observation' once one exists. */
  retry: 'observation' | 'media' | null;
}

/** How a prompt answer reads back: "How busy is it? · Busy". */
export function answerSummary(kind: MapContributionKind, value: string): string {
  const label = CONTRIBUTION_OPTIONS[kind]?.find((o) => o.value === value)?.label ?? value;
  return `${CONTRIBUTION_PROMPT_LABELS[kind]} · ${label}`;
}

const MEDIA_NOUN: Record<MediaKind, string> = { photo: 'photo', video: 'video' };

/**
 * The sentence for a failed leg.
 *
 * `not_enabled` is deliberately NOT phrased as an error — nothing broke, the
 * capability is switched off — but it is also not phrased as a success, because
 * nothing was stored.
 */
function failureText(reason: ContributionFailureReason, what: string): string {
  switch (reason) {
    case 'not_enabled':
      return `Reporting is not switched on here yet, so ${what} was not recorded.`;
    case 'refused':
      return `${what} was not recorded.`;
    case 'upload_failed':
      return `${what} could not be uploaded.`;
    case 'transport_failed':
      return `${what} could not be sent.`;
    case 'not_constructible':
      return `${what} could not be sent.`;
  }
}

/** Opening state: the proposition is in flight and nothing exists yet. */
export function beginObservation(kind: MapContributionKind, value: string): ContributionFlowState {
  return {
    phase: 'submitting',
    observationId: null,
    answer: answerSummary(kind, value),
    status: 'Recording your report…',
    detail: null,
    busy: true,
    retry: null,
  };
}

/** Fold step 1's outcome into what the contributor sees. */
export function settleObservation(
  prev: ContributionFlowState,
  outcome: ObservationOutcome,
): ContributionFlowState {
  if (!outcome.ok) {
    return {
      ...prev,
      phase: 'observation_failed',
      observationId: null,
      status: failureText(outcome.reason, 'Your report'),
      detail: outcome.detail,
      busy: false,
      // Nothing was stored, so re-running step 1 cannot duplicate anything.
      retry: outcome.reason === 'not_enabled' ? null : 'observation',
    };
  }
  return {
    ...prev,
    phase: 'observed',
    observationId: outcome.observationId,
    status: outcome.deduped ? 'Already recorded.' : 'Report recorded.',
    detail: null,
    busy: false,
    retry: null,
  };
}

/** The media leg starts. The observation already exists and stays untouched. */
export function beginMedia(prev: ContributionFlowState, kind: MediaKind): ContributionFlowState {
  return {
    ...prev,
    phase: 'attaching',
    status: `Attaching your ${MEDIA_NOUN[kind]}…`,
    detail: null,
    busy: true,
    retry: null,
  };
}

/**
 * Fold step 2's outcome in.
 *
 * The failure sentence always states BOTH halves — "your report was recorded,
 * the photo was not" — because the contributor performed one act and half of it
 * landed. Saying only "could not attach the photo" would leave them unsure
 * whether to report the place again, and reporting it again is exactly the
 * duplicate observation this flow refuses to create.
 */
export function settleMedia(
  prev: ContributionFlowState,
  outcome: MediaEvidenceOutcome,
  kind: MediaKind,
): ContributionFlowState {
  if (outcome.ok) {
    return {
      ...prev,
      phase: 'attached',
      status: outcome.deduped
        ? `That ${MEDIA_NOUN[kind]} is already attached to your report.`
        : `${MEDIA_NOUN[kind] === 'photo' ? 'Photo' : 'Video'} attached to your report.`,
      detail: null,
      busy: false,
      retry: null,
    };
  }
  if (outcome.reason === 'cancelled') {
    // Backing out of the picker is not a failure and leaves the act where it
    // was: an observation, recorded, with no artifact attached.
    return { ...prev, phase: 'observed', status: 'Report recorded.', detail: null, busy: false, retry: null };
  }
  return {
    ...prev,
    phase: 'attach_failed',
    status: `Your report was recorded. ${failureText(outcome.reason, `The ${MEDIA_NOUN[kind]}`)}`,
    detail: outcome.detail,
    busy: false,
    // Only ever the media leg. The observation is stored; re-running it would
    // make a second one out of a single act.
    retry: outcome.reason === 'not_enabled' ? null : 'media',
  };
}
