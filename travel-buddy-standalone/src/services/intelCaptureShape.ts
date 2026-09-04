/**
 * Intelligence Gathering — capture request SHAPE (pure).
 *
 * The request-body builder and the per-write input factories, with NO runtime
 * dependencies (type-only imports). intelCapture.ts (which pulls in supabase /
 * react-native for the network call) imports these so the SHAPE of every capture
 * write can be unit-tested without the native runtime.
 */
import type { QuickSignalContext, Visibility, PartySizeBucket, CommercialDisclosure } from '../lib/intel/contracts.ts';

// ── The write payload ────────────────────────────────────────────────────────
export interface ObservationInput {
  subjectId: string;
  subjectKind?: string;
  zoneId?: string | null;
  /** Defaults to now at call time if omitted. */
  observedAt?: string;
  capturedAt?: string | null;
  visibility?: Visibility;
  presenceLevel?: string;
  /**
   * Which §6 capture surface this write comes from. Omitted ⇒ 'quick_signal'
   * (the server default). The Trail movement follow-up sends 'trail'.
   */
  captureSurface?: 'quick_signal' | 'trail';
  /** Quick Signal / Trail form: a context + a chosen option, mapped server-side. */
  context?: QuickSignalContext;
  option?: string;
  /** Direct form: an already-canonical Phase-1 claim. */
  claimType?: string;
  value?: Record<string, unknown>;
  /**
   * V1 independent-group signal: the "who are you here with?" answer. The server
   * derives a privacy-safe group_key from it; omitting it is fail-closed (null
   * group_key, no credit toward the independent-group floor). Only sent for
   * label-eligible captures.
   */
  partySize?: PartySizeBucket;
  /**
   * The observer's active Trip Crew id, if the client already knows it. Optional
   * and normally omitted — the server resolves the active crew itself and
   * VALIDATES membership before honouring any value here.
   */
  partyId?: string | null;
  /**
   * §22 Table 30 commercial disclosure. A non-'none' value makes the server record
   * the report under a NON_INDEPENDENT source class (never independent consensus).
   * Omitted / 'none' is not sent — the server defaults to 'none'.
   */
  commercialDisclosure?: CommercialDisclosure;
  /** Reused across retries of the same logical write. Minted if omitted. */
  idempotencyKey?: string;
}

/** Build the POST body the observations route accepts (pure — no clock beyond the fallback). */
export function buildObservationBody(input: ObservationInput): Record<string, unknown> {
  const body: Record<string, unknown> = {
    subjectId: input.subjectId,
    observedAt: input.observedAt ?? new Date().toISOString(),
  };
  if (input.subjectKind) body.subjectKind = input.subjectKind;
  if (input.captureSurface) body.captureSurface = input.captureSurface;
  if (input.zoneId !== undefined) body.zoneId = input.zoneId;
  if (input.capturedAt !== undefined) body.capturedAt = input.capturedAt;
  if (input.visibility) body.visibility = input.visibility;
  if (input.presenceLevel) body.presenceLevel = input.presenceLevel;
  if (input.context && input.option) {
    body.context = input.context;
    body.option = input.option;
  } else if (input.claimType && input.value) {
    body.claimType = input.claimType;
    body.value = input.value;
  }
  // Independent-group signal — omitted entirely when unset (server fail-closes).
  if (input.partySize) body.partySize = input.partySize;
  if (input.partyId) body.partyId = input.partyId;
  // Commercial disclosure — only sent when the traveler declared a relationship;
  // 'none' is the server default, so an untouched control adds nothing.
  if (input.commercialDisclosure && input.commercialDisclosure !== 'none') {
    body.commercialDisclosure = input.commercialDisclosure;
  }
  return body;
}

// ── Per-write input factories (the SHAPE of each convenience call) ────────────
export interface QuickSignalArgs {
  subjectId: string;
  context: QuickSignalContext;
  option: string;
  visibility?: Visibility;
  zoneId?: string | null;
  subjectKind?: string;
  partySize?: PartySizeBucket;
  partyId?: string | null;
  commercialDisclosure?: CommercialDisclosure;
  idempotencyKey?: string;
}
export const quickSignalInput = (a: QuickSignalArgs): ObservationInput => ({ ...a });

export interface WalkInArgs {
  subjectId: string;
  accepted: boolean;
  visibility?: Visibility;
  partySize?: PartySizeBucket;
  partyId?: string | null;
  commercialDisclosure?: CommercialDisclosure;
  idempotencyKey?: string;
}
export const walkInInput = (a: WalkInArgs): ObservationInput => ({
  subjectId: a.subjectId,
  claimType: 'access.walk_in',
  value: { accepted: a.accepted },
  visibility: a.visibility,
  partySize: a.partySize,
  partyId: a.partyId,
  commercialDisclosure: a.commercialDisclosure,
  idempotencyKey: a.idempotencyKey,
});

export interface MusicArgs {
  subjectId: string;
  genre: string;
  visibility?: Visibility;
  zoneId?: string | null;
  partySize?: PartySizeBucket;
  partyId?: string | null;
  commercialDisclosure?: CommercialDisclosure;
  idempotencyKey?: string;
}
export const musicInput = (a: MusicArgs): ObservationInput => ({
  subjectId: a.subjectId,
  claimType: 'music.current',
  value: { genre: a.genre },
  visibility: a.visibility,
  zoneId: a.zoneId,
  partySize: a.partySize,
  partyId: a.partyId,
  commercialDisclosure: a.commercialDisclosure,
  idempotencyKey: a.idempotencyKey,
});

export interface TrailMovementArgs {
  subjectId: string;
  /** A coarse area name from the existing area vocabulary — never coordinates. */
  destinationArea: string;
  visibility?: Visibility;
  commercialDisclosure?: CommercialDisclosure;
  idempotencyKey?: string;
}
export const trailMovementInput = (a: TrailMovementArgs): ObservationInput => ({
  subjectId: a.subjectId,
  captureSurface: 'trail',
  context: 'movement',
  option: a.destinationArea,
  visibility: a.visibility,
  commercialDisclosure: a.commercialDisclosure,
  idempotencyKey: a.idempotencyKey,
});
