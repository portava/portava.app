/**
 * intelEvidenceCapture — the EVIDENCE station of the §21 pipeline.
 *
 *   Observation → Evidence → Claim → Confidence → Freshness → Correction
 *
 * §22's eighth map prompt is "Current photo/video". Seven of the eight prompts
 * are propositions and become CLAIMS; this one is not, and never will be. The
 * ruling that kept media out of the claim system is unchanged and is restated
 * here because this module is the place that could most easily break it:
 *
 *   A photo asserts no proposition. Ask which claim a photo of a bar makes and
 *   there is no answer — "it is busy"? "it is open"? The contributor stated
 *   none of those. It also cannot expire into "wrong": the picture stays an
 *   accurate picture of a moment forever, so any TTL would be a statement about
 *   the WORLD, and would belong to whatever claim the photo is evidence FOR.
 *
 * What changed is not the ruling but the destination. §21 already names the
 * station a photo belongs to, and migration 2130 already built the table for it
 * — `intel_evidence`, "artifacts supporting an observation". So media now
 * LANDS, as evidence bolted to an observation that a person already made, and
 * it still mints no claim type, no confidence and no map change.
 *
 * WHY EVIDENCE MAY NOT ARRIVE ALONE
 * =================================
 * `intel_evidence.observation_id` is NOT NULL and FKs `intel_observations`. A
 * standalone photo has nothing to support, and the only two ways to store one
 * would be to invent a claim for it (forbidden, and the whole point of the
 * ruling) or to loosen that column (which would turn an evidence table into an
 * unattached media store with no purpose, no retention rationale and no
 * lawful basis of its own — the intel_claim purpose covers CONTRIBUTIONS).
 *
 * So the caller must submit the observation FIRST and resend the media with
 * that observation's id. This is the §21 order made mechanical rather than
 * advisory. `routes/mapObservations.ts` refuses a media contribution carrying
 * no `observationId`, loudly, with the ruling as the reason.
 *
 * WHY A CLIENT `mediaUri` IS NEVER STORED AS SENT
 * ===============================================
 * A `mediaUri` is untrusted input. Stored raw it would be a pointer the server
 * later fetches or serves, i.e. an arbitrary-host injection (hotlink, tracker,
 * SSRF-on-render) and — worse here — a way to publish someone ELSE's private
 * object by guessing its key. The codebase already settled this twice, and this
 * module reuses the same two checks in the same order that `routes/stories.ts`
 * applies to a story's media:
 *
 *   1. `appStorageUrlInfo` — proves the bytes are OURS (an allowed bucket on
 *      our own storage origin, or a bare `<bucket>/<path>` key). Anything else
 *      is refused; nothing is coerced.
 *   2. `ownerFromPath(...) === actorId` — proves the bytes are THEIRS.
 *      appStorageUrlInfo says whose HOST, never whose OBJECT.
 *
 * What is persisted is NOT that `<bucket>/<path>` key: its first segment is the
 * uploader's ACCOUNT id, and 3002 tokenises every contributor id in this table.
 * The key is SEALED to its observation (see "THE SEALED REFERENCE" at the end of
 * this file). No URL, no origin, no token, and no account id, in any encoding.
 *
 * The object itself is one the contributor uploaded through POST
 * /api/media/upload, which strips EXIF/GPS before writing the bytes — so this
 * table does not become the second location store 2130's own column comment
 * warns against.
 *
 * WHAT THIS MODULE MAY NEVER DO
 * =============================
 *   • mint a claim, a claim type, a confidence, a band or a snapshot;
 *   • write an observation (that is IntelCaptureService's job, and duplicating
 *     it is the defect the map route's header already warns about);
 *   • raise confidence. `lib/intelProjectionAggregator` sets `hasEvidence`
 *     to a hardcoded `false` and this module deliberately does not change that:
 *     evidence quality is a scoring input nobody has ruled on for unmoderated
 *     contributor media, and wiring it here would make attaching a photo a
 *     one-tap confidence boost. That is the same failure mode as a paid
 *     contribution scoring higher, and §22 forbids it for the same reason.
 *
 * WHY UNMODERATED MEDIA IS SAFE TO STORE HERE TODAY
 * =================================================
 * `intel_evidence` has no moderation column, and this path adds none. It is
 * nevertheless not a publication surface:
 *
 *   • migration 2130 grants `authenticated` NOTHING on the table (only
 *     `intel_observations` and `intel_confirmations` get SELECT), and RLS is on
 *     with no policy for it — so it is service-role-only;
 *   • no read path exists: nothing in the projection, the API projection or any
 *     route selects from it, and `hasEvidence` is a constant;
 *   • the BYTES stay governed by the existing private-bucket rules
 *     (`lib/mediaAccess`), unchanged by this row — a reference does not widen
 *     access to an object.
 *
 * A read path serving evidence to anyone but its OWN contributor therefore may not
 * be added without a moderation decision first. `test/mapMediaEvidence.test.ts`
 * pins "no route reads it" and "nothing but this file selects `reference`".
 */
import { isFlagEnabled } from "./featureFlags.js";
import { clampObservedAt } from "./intelContracts.js";
import { hasValidIntelConsent, readOwnContributorIdentities } from "./intelConsent.js";
import { appStorageUrlInfo } from "./mediaUrl.js";
import { ownerFromPath } from "./mediaAccess.js";
import { INTEL_IDENTIFIABLE_RETENTION_SECONDS } from "./locationPurposes.js";

/**
 * §22's asset vocabulary mapped onto `intel_evidence.evidence_kind`.
 *
 * Identity, not translation — and that is the point. 2130's CHECK constraint
 * admitted 'photo' but not 'video', so before migration 2223 a video could only
 * have been stored by FILING IT AS A PHOTO, which is the mis-file this whole
 * unit exists to refuse. 2223 widens the constraint instead.
 */
export const MEDIA_EVIDENCE_KIND: Readonly<Record<string, string>> = {
  photo: "photo",
  video: "video",
};

/**
 * Provenance written into `intel_evidence.detail`.
 *
 * A CONSTANT, deliberately. `detail` is classified `contributor_licensed` and
 * "may contain personal data" precisely because it is where free text would go
 * — and the §22 payload carries no free text at all. Writing a server-derived
 * marker keeps that true by construction: this path cannot put contributor
 * prose, coordinates or a caption into the column.
 */
export const EVIDENCE_SOURCE_MAP_CONTRIBUTION = "map_contribution";

export interface EvidenceInput {
  /** The observation this artifact supports. Required — see the header. */
  observationId: string | null | undefined;
  /** The map object the contribution named; must match the observation's subject. */
  subjectId: string;
  /** Untrusted client reference. Validated, never stored as sent. */
  mediaUri: string;
  /** §22 asset type: 'photo' | 'video'. */
  mediaKind: string;
  /** Client capture time, clamped by the same contract the observation used. */
  observedAt: string | number | Date;
}

export type EvidenceRejection =
  /** The capture surface itself is off. */
  | "disabled"
  /** No valid, un-withdrawn Intelligence Contributions consent (D4). */
  | "consent_required"
  /** Media arrived with no observation to support. */
  | "evidence_requires_observation"
  /** Not an asset type §22 names. */
  | "unsupported_media_kind"
  /** Future-dated beyond the contract's drift allowance. */
  | "invalid_observed_at"
  /** Not a reference to an object in our own storage. */
  | "invalid_media_reference"
  /** Ours, but not the contributor's. */
  | "media_not_owned"
  /** No such observation, or not this actor's. The two are not distinguished. */
  | "unknown_observation"
  /** The observation is about a different subject than the contribution named. */
  | "observation_subject_mismatch"
  | "db_error" | "reference_key_unavailable" | "consent_does_not_cover_photos"; // the last two: INTEL_EVIDENCE_REFERENCE_KEY unset or short (the key cannot be sealed), and a recorded disclosure whose words name no photos (Gate 2b). Both store nothing

export type EvidenceResult =
  | { ok: true; evidence: any; deduped: boolean }
  | { ok: false; reason: EvidenceRejection; detail?: string };

function reject(reason: EvidenceRejection, detail?: string): EvidenceResult {
  return { ok: false, reason, detail };
}

/**
 * Resolve an untrusted `mediaUri` to a storage key this actor owns.
 *
 * Exported because it is the security decision of this module and deserves to
 * be testable on its own, without a database. Returns the bucket-qualified key
 * (which is SEALED before anything stores it — see the end of this file), or the reason it was refused.
 */
export function resolveOwnedMediaReference(
  mediaUri: string,
  actorId: string,
): { ok: true; reference: string } | { ok: false; reason: EvidenceRejection } {
  const ref = appStorageUrlInfo(mediaUri);
  // Not ours: an external host, a foreign origin, a bucket outside the media
  // allow-list, or a path-traversal attempt. Refused, never coerced.
  if (!ref) return { ok: false, reason: "invalid_media_reference" };
  // Ours, but whose? appStorageUrlInfo answers "which host", never "which
  // owner", so a guessed key for someone else's private object would pass it.
  if (ownerFromPath(ref.path) !== actorId) return { ok: false, reason: "media_not_owned" };
  return { ok: true, reference: `${ref.bucket}/${ref.path}` };
}

/**
 * Attach one media artifact to an existing observation.
 *
 * Every gate below is the SAME function the observation path used, called
 * again — not a second implementation of it. The capture flag, the consent
 * check and the observed-at clamp are `isFlagEnabled`, `hasValidIntelConsent`
 * and `clampObservedAt` themselves, so the two paths cannot drift on the rules
 * whose absence is invisible in a response.
 */
export async function attachMediaEvidence(
  sc: any,
  actorId: string,
  input: EvidenceInput,
): Promise<EvidenceResult> {
  // Gate 1 — the capture surface. Literal flag arg so check-flag-polarity can
  // resolve this stop statically. This is the SECOND half of the double gate:
  // the route has already required map_contributions_enabled, and evidence must
  // not be a way into the intel store while intel capture itself is switched
  // off. Ordered first, before consent, exactly as writeObservation orders it.
  if (!(await isFlagEnabled(sc, "intel_capture_quick_signal"))) return reject("disabled");

  // Gate 2 — D4 lawful basis. A photo of a place, tied to a person and a time,
  // is a contribution under the consent-based `intel_claim` purpose just as much
  // as the observation it supports. Fail-closed.
  if (!(await hasValidIntelConsent(sc, actorId))) return reject("consent_required");
  const photos = await consentCoversPhotoEvidence(sc, actorId); if (!photos.covered) return reject(photos.reason, photos.detail); // Gate 2b — the words agreed to must name photos (end of file)
  // Gate 3 — evidence cannot precede the observation it supports (§21).
  if (!input.observationId) return reject("evidence_requires_observation");

  const evidenceKind = MEDIA_EVIDENCE_KIND[input.mediaKind];
  if (!evidenceKind) return reject("unsupported_media_kind", String(input.mediaKind));

  // Gate 4 — the same clamp the observation passed. A device clock cannot buy a
  // future-dated artifact any more than it can buy a future-dated claim.
  const clamped = clampObservedAt(input.observedAt);
  if (!clamped) return reject("invalid_observed_at");

  // Gate 5 — the untrusted reference: proved ours, proved theirs, then SEALED (end of file).
  const resolved = resolveAndSealOwnedMediaReference(input.mediaUri, actorId, input.observationId); // the key names the ACCOUNT; only the sealed form is ever stored
  if (!resolved.ok) return reject(resolved.reason);

  // Gate 6a — WHICH STORED VALUES ARE THIS ACTOR'S.
  //
  // `intel_observations.actor_id` stopped being an account id at migration 3002:
  // a BEFORE INSERT trigger replaces it with a rotating contributor token, one
  // PER 7-DAY EPOCH, derived from a pepper no application role may read. So
  // `obs.actor_id !== actorId` compares a token with an account id and is false
  // for the owner's own observation — every media contribution would be refused
  // as `unknown_observation`. A single-epoch lookup would not be enough either:
  // an observation made last week carries last week's token.
  //
  // RESOLVED BEFORE THE OBSERVATION IS READ, ON PURPOSE. It does not depend on
  // the observation, and doing it first keeps the collapse below intact: if this
  // failed after the lookup, a `db_error` would only ever be returned for an id
  // that EXISTS, which is precisely the existence oracle the collapse prevents.
  // Failing here says nothing about any observation id.
  const identities = await readOwnContributorIdentities(sc, actorId);
  if (!identities.ok) {
    // Fail CLOSED and DISTINGUISHABLY. Ownership is unknown, not disproved, so
    // this must not be reported as `unknown_observation` — that is the answer for
    // "not yours", and a client told that will not retry. db_error is retryable.
    return reject("db_error", `contributor identity lookup: ${identities.detail}`);
  }
  const ownIdentities = new Set(identities.identities);

  // Gate 6 — the parent observation must exist, be THIS actor's, and be about
  // the subject the contribution named.
  const { data: obs, error: obsErr } = await sc
    .from("intel_observations")
    .select("id, actor_id, subject_id")
    .eq("id", input.observationId)
    .maybeSingle();
  if (obsErr) return reject("db_error", "observation lookup");
  // A missing observation and another actor's observation collapse to ONE
  // answer on purpose: distinguishing them would turn this endpoint into an
  // oracle for "does this observation id exist", which is a contribution
  // someone else made about a place they were at.
  if (!obs || !obs.actor_id || !ownIdentities.has(String(obs.actor_id))) {
    return reject("unknown_observation");
  }
  if (obs.subject_id !== input.subjectId) {
    return reject("observation_subject_mismatch", "the observation is about a different subject");
  }

  // Retention. `intel_evidence.expires_at` is a RETENTION deadline, not a truth
  // TTL — the ruling is explicit that a photo does not expire into "wrong", and
  // dataRights records the column as "when evidence goes, not what it contains".
  // Anchored to NOW rather than to observed_at so the declared deadline is the
  // one migration 2173's sweep actually enforces: that sweep deletes on
  // created_at < now() - 180d, and created_at is this instant. Anchoring to the
  // (earlier) observed_at would declare a deadline the sweep then missed.
  const expiresAt = new Date(Date.now() + INTEL_IDENTIFIABLE_RETENTION_SECONDS * 1000).toISOString();

  const row = {
    observation_id: input.observationId,
    actor_id: actorId,
    evidence_kind: evidenceKind,
    reference: resolved.reference, // `ievr1.…` — sealed to this observation; carries no account id
    detail: { source: EVIDENCE_SOURCE_MAP_CONTRIBUTION },
    expires_at: expiresAt,
  };

  const { data, error } = await sc.from("intel_evidence").insert(row).select().single();
  if (error) {
    // Idempotency. One tap is regularly two events, and the table is append-only
    // so a duplicate cannot be cleaned up afterwards. Migration 2223 adds the
    // unique (observation_id, reference) index that makes the replay detectable
    // rather than merely unlikely; a 23505 is that replay.
    if (String((error as any).code) === "23505") {
      const { data: existing, error: replayErr } = await sc
        .from("intel_evidence")
        .select("*")
        .eq("observation_id", input.observationId)
        .eq("reference", resolved.reference)
        .maybeSingle();
      // intel_evidence is append-only, so the safe direction on an unconfirmed
      // replay is the rejection below — never a fabricated success. But the
      // detail it carried was the 23505, i.e. the *constraint* the replay was
      // supposed to explain; an unreadable table was reported as a duplicate
      // key. Name the real fault so a retry storm is diagnosable.
      if (replayErr) {
        return reject("db_error", `replay lookup failed: ${String(replayErr.message ?? "")}`);
      }
      if (existing) return { ok: true, evidence: existing, deduped: true };
    }
    return reject("db_error", String((error as any).message ?? ""));
  }

  // NOTE WHAT DOES NOT HAPPEN HERE: no claim, no confidence, no snapshot, no
  // reward, and no change to the observation — which is append-only anyway.
  return { ok: true, evidence: data, deduped: false };
}

// ═══════════════════════════════════════════════════════════════════════════
// THE SEALED REFERENCE (census-map §45; found by lane I, census-media §35.7)
// ═══════════════════════════════════════════════════════════════════════════
//
// WHAT WAS WRONG. `intel_evidence.reference` used to hold the storage key that
// resolveOwnedMediaReference proves, as is. Every key POST /api/media/upload
// mints is `post-media/<ACCOUNT uuid>/<ms>.<ext>` (routes/posts.ts builds it from
// `user.id`), and that first segment is exactly what `ownerFromPath(...) ===
// actorId` relies on. Migration 3002 replaces `actor_id` on this table with a
// rotating contributor token so that no stored contribution names an account;
// the key put the account back one column over. A row therefore resolved its
// observation to its author and, through the shared weekly token, every other
// observation that author made that week.
//
// WHY NOT `media_assets.id`. It is neither guaranteed nor opaque. The upload
// route writes the canonical row fire-and-forget and only while
// `media_canonical_enabled` is on, so at capture time it may not exist; and
// `media_assets.owner_user_id` is one join away for anything that can read this
// table, which is the same re-identification, derivable instead of direct.
//
// WHAT IS STORED NOW: `ievr1.` + base64url(iv ‖ ciphertext ‖ tag). The key is
// zero-padded to a multiple of 64 bytes and encrypted with AES-256-GCM under a
// key derived (HKDF-SHA256) from INTEL_EVIDENCE_REFERENCE_KEY, a server secret
// that is not in the database, let alone in the row. Three properties, each
// pinned by test/intelEvidenceReference.test.ts:
//
//   • NO ACCOUNT ID, in any substring or encoding. The ciphertext is
//     pseudo-random, the padding hides the key's length, and nothing else this
//     path writes is derived from the key.
//   • BOUND TO ITS OBSERVATION. The observation id is the GCM additional data,
//     so a reference copied onto another row does not open.
//   • DETERMINISTIC PER (observation, object), UNLINKABLE ACROSS observations.
//     The IV is an HMAC of (observation, padded key) under a second derived key
//     (a synthetic IV, the SIV construction). A double-tap therefore replays to
//     the same value and 2223's unique (observation_id, reference) index still
//     dedupes it, while the same photo attached to two observations, in two
//     weeks under two tokens, yields two unrelated references. A reference
//     derived from the key alone would have re-linked the weekly tokens it sits
//     beside.
//
// WHO CAN OPEN IT. Code holding the key, through the two readers below and
// nothing else: resolveEvidenceMediaForContributor (the contributor's own
// object, through the byte gate) and collectOwnEvidenceObjectKeys (account
// deletion's search for the bytes). A third, rekeyLegacyEvidenceReferences,
// reads only pre-seal plaintext rows, in order to seal them. No route calls
// any of the three.
//
// THE RESIDUAL, STATED. The application holds the key, so the application can
// open any reference. That is the same class of residual 3002 records for its
// pepper, and it is why the key is a dedicated secret: a database reader (a SQL
// console, a replica, a dump, a leaked service-role key) cannot open a
// reference, and cannot join one to an account.
//
// NO FALLBACK KEY, for the reason lib/envValidation gives for
// SENSING_CONTRIBUTOR_PEPPER. A reference sealed under SESSION_SECRET would stop
// opening on a routine session-secret rotation, and a reference that does not
// open is an object account deletion cannot find. Unset, or shorter than 32
// characters, means capture refuses (`reference_key_unavailable`) and stores
// nothing. Treat the key as stable: rotating it needs every row re-sealed under
// the new key first, and no tool for that exists yet.
import { createCipheriv, createDecipheriv, createHmac, hkdfSync, timingSafeEqual } from "node:crypto";
import { authorizeMediaAccess } from "./mediaAccess.js";

/** Version prefix of a sealed reference. A value without it is a pre-3360 plaintext key. */
export const EVIDENCE_REFERENCE_PREFIX = "ievr1.";
/** Minimum length of INTEL_EVIDENCE_REFERENCE_KEY. Enforced, not advisory. */
export const EVIDENCE_REFERENCE_KEY_MIN_LENGTH = 32;

/** Versioned context (house idiom: lib/intelGroupKey GROUP_KEY_CONTEXT). */
const EVIDENCE_REFERENCE_CONTEXT = "intel-evidence-reference/v1";
const EVIDENCE_REFERENCE_IV_BYTES = 12;
const EVIDENCE_REFERENCE_TAG_BYTES = 16;
/** Padding block. Every storage key the upload route mints fits one block. */
const EVIDENCE_REFERENCE_PAD_BYTES = 64;

interface EvidenceReferenceKeys {
  enc: Buffer;
  siv: Buffer;
}

/** The two derived keys, or null when the secret is unset or too short. Read per call. */
function evidenceReferenceKeys(): EvidenceReferenceKeys | null {
  const secret = process.env.INTEL_EVIDENCE_REFERENCE_KEY;
  if (typeof secret !== "string" || secret.trim().length < EVIDENCE_REFERENCE_KEY_MIN_LENGTH) return null;
  const ikm = Buffer.from(secret, "utf8");
  const salt = Buffer.from(EVIDENCE_REFERENCE_CONTEXT, "utf8");
  return {
    enc: Buffer.from(hkdfSync("sha256", ikm, salt, "enc", 32)),
    siv: Buffer.from(hkdfSync("sha256", ikm, salt, "siv", 32)),
  };
}

/** Uuid case variants of one observation id must seal and open identically. */
function referenceAad(observationId: string): Buffer {
  return Buffer.from(`${EVIDENCE_REFERENCE_CONTEXT}|${observationId.trim().toLowerCase()}`, "utf8");
}

function syntheticIv(keys: EvidenceReferenceKeys, aad: Buffer, padded: Buffer): Buffer {
  return createHmac("sha256", keys.siv)
    .update(aad)
    .update(Buffer.from([0]))
    .update(padded)
    .digest()
    .subarray(0, EVIDENCE_REFERENCE_IV_BYTES);
}

/** Is this stored value a sealed reference (as opposed to a legacy plaintext key)? */
export function isSealedEvidenceReference(value: unknown): value is string {
  return typeof value === "string" && value.startsWith(EVIDENCE_REFERENCE_PREFIX);
}

export type SealEvidenceReferenceResult =
  | { ok: true; reference: string }
  | { ok: false; reason: "reference_key_unavailable" | "invalid_media_reference" };

/**
 * Seal a storage key to the observation it supports. Pure apart from reading
 * the key from the environment. It proves NOTHING about ownership: callers
 * seal only a key resolveOwnedMediaReference has already proved.
 */
export function sealEvidenceReference(storageKey: string, observationId: string): SealEvidenceReferenceResult {
  if (typeof storageKey !== "string" || storageKey.length === 0 || storageKey.includes("\0")) {
    return { ok: false, reason: "invalid_media_reference" };
  }
  if (typeof observationId !== "string" || observationId.trim().length === 0) {
    return { ok: false, reason: "invalid_media_reference" };
  }
  const keys = evidenceReferenceKeys();
  if (!keys) return { ok: false, reason: "reference_key_unavailable" };

  const plain = Buffer.from(storageKey, "utf8");
  // At least one zero byte, so the length is visible only to the nearest block.
  const padded = Buffer.alloc(Math.ceil((plain.length + 1) / EVIDENCE_REFERENCE_PAD_BYTES) * EVIDENCE_REFERENCE_PAD_BYTES);
  plain.copy(padded);
  const aad = referenceAad(observationId);
  const iv = syntheticIv(keys, aad, padded);
  const cipher = createCipheriv("aes-256-gcm", keys.enc, iv);
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(padded), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { ok: true, reference: EVIDENCE_REFERENCE_PREFIX + Buffer.concat([iv, ciphertext, tag]).toString("base64url") };
}

export type OpenEvidenceReferenceResult =
  | { ok: true; storageKey: string }
  | { ok: false; reason: "not_sealed" | "reference_key_unavailable" | "unopenable" };

/**
 * Open a sealed reference for the observation its row names. Anything that does
 * not authenticate — another observation's reference, a truncated or edited
 * value, a different key — is `unopenable`, never a guess.
 */
export function openEvidenceReference(reference: unknown, observationId: unknown): OpenEvidenceReferenceResult {
  if (!isSealedEvidenceReference(reference)) return { ok: false, reason: "not_sealed" };
  if (typeof observationId !== "string" || observationId.trim().length === 0) return { ok: false, reason: "unopenable" };
  const keys = evidenceReferenceKeys();
  if (!keys) return { ok: false, reason: "reference_key_unavailable" };

  const body = reference.slice(EVIDENCE_REFERENCE_PREFIX.length);
  if (!/^[A-Za-z0-9_-]+$/.test(body)) return { ok: false, reason: "unopenable" };
  const raw = Buffer.from(body, "base64url");
  const cipherLength = raw.length - EVIDENCE_REFERENCE_IV_BYTES - EVIDENCE_REFERENCE_TAG_BYTES;
  if (cipherLength < EVIDENCE_REFERENCE_PAD_BYTES || cipherLength % EVIDENCE_REFERENCE_PAD_BYTES !== 0) {
    return { ok: false, reason: "unopenable" };
  }
  const iv = raw.subarray(0, EVIDENCE_REFERENCE_IV_BYTES);
  const ciphertext = raw.subarray(EVIDENCE_REFERENCE_IV_BYTES, EVIDENCE_REFERENCE_IV_BYTES + cipherLength);
  const tag = raw.subarray(EVIDENCE_REFERENCE_IV_BYTES + cipherLength);
  const aad = referenceAad(observationId);

  let padded: Buffer;
  try {
    const decipher = createDecipheriv("aes-256-gcm", keys.enc, iv);
    decipher.setAAD(aad);
    decipher.setAuthTag(tag);
    padded = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    return { ok: false, reason: "unopenable" };
  }
  // The IV must be the one this plaintext and this observation produce.
  if (!timingSafeEqual(iv, syntheticIv(keys, aad, padded))) return { ok: false, reason: "unopenable" };
  const end = padded.indexOf(0);
  if (end <= 0) return { ok: false, reason: "unopenable" };
  for (let i = end; i < padded.length; i += 1) {
    if (padded[i] !== 0) return { ok: false, reason: "unopenable" };
  }
  return { ok: true, storageKey: padded.subarray(0, end).toString("utf8") };
}

/**
 * Gate 5 as attachMediaEvidence calls it: the same ownership proof as before,
 * then the seal. The refusal reasons are resolveOwnedMediaReference's, plus
 * `reference_key_unavailable`. Refusing here, before the identity and
 * observation reads, keeps the refusal independent of any observation id.
 */
export function resolveAndSealOwnedMediaReference(
  mediaUri: string,
  actorId: string,
  observationId: string | null | undefined,
): { ok: true; reference: string } | { ok: false; reason: EvidenceRejection } {
  const resolved = resolveOwnedMediaReference(mediaUri, actorId);
  if (!resolved.ok) return resolved;
  const sealed = sealEvidenceReference(resolved.reference, String(observationId ?? ""));
  if (!sealed.ok) return { ok: false, reason: sealed.reason };
  return { ok: true, reference: sealed.reference };
}

// ── Reader 1: the contributor's own evidence, through the byte gate ─────────

export type EvidenceMediaRefusal =
  | "invalid_input"
  /** No such evidence, or not this viewer's. The two are not distinguished. */
  | "not_found"
  /** The row references no stored object (text_note, sensor, the media seam). */
  | "no_media"
  | "unopenable"
  | "reference_key_unavailable"
  /** The byte gate (lib/mediaAccess) refuses this viewer the object. */
  | "not_authorized"
  | "db_error";

export type EvidenceMediaResolution =
  | { ok: true; bucket: string; path: string }
  | { ok: false; reason: EvidenceMediaRefusal; detail?: string };

/**
 * Map one evidence row back to its object, for the one viewer entitled to know
 * which object it is: the contributor who attached it.
 *
 * TWO AUTHORIZATIONS, AND BOTH ARE NEEDED.
 *   1. The row must be THIS viewer's: its `actor_id` must be one of the values
 *      3310's bridge derives from the viewer's own account (the account id, and
 *      each epoch's token). This is not the byte gate's question. The byte gate
 *      asks "may this viewer see these bytes?", and for a photo that is also a
 *      public post, or an avatar on a public profile, the answer for a stranger
 *      is yes. Telling that stranger "this photo backs observation O" would
 *      still re-identify O's contributor, so a stranger is refused before the
 *      byte gate is asked.
 *   2. The byte gate itself (`authorizeMediaAccess`), so a contributor is never
 *      handed an object their own row does not entitle them to: a story they
 *      deleted, or a row whose key names someone else's object ("a row is not
 *      a promise").
 *
 * A missing row and another person's row get the same answer, as in the
 * capture path. Serving evidence to anyone else (a moderator, another
 * traveller) is the moderation and visibility decision this module's header
 * reserves, and is not built here. No route calls this function.
 */
export async function resolveEvidenceMediaForContributor(
  sc: any,
  viewerId: string,
  evidenceId: string,
): Promise<EvidenceMediaResolution> {
  if (!sc || !viewerId || !evidenceId) return { ok: false, reason: "invalid_input" };

  // Identities first, for the reason Gate 6a gives: a failure here must not be
  // an oracle for which evidence ids exist.
  const identities = await readOwnContributorIdentities(sc, viewerId);
  if (!identities.ok) return { ok: false, reason: "db_error", detail: `contributor identity lookup: ${identities.detail}` };

  const { data: row, error } = await sc
    .from("intel_evidence")
    .select("id, observation_id, actor_id, reference")
    .eq("id", evidenceId)
    .maybeSingle();
  if (error) return { ok: false, reason: "db_error", detail: "evidence lookup" };
  if (!row || !row.actor_id || !new Set(identities.identities).has(String(row.actor_id))) {
    return { ok: false, reason: "not_found" };
  }

  const stored = typeof row.reference === "string" ? row.reference.trim() : "";
  if (!stored) return { ok: false, reason: "no_media" };
  let storageKey: string;
  if (isSealedEvidenceReference(stored)) {
    const opened = openEvidenceReference(stored, row.observation_id);
    if (!opened.ok) return { ok: false, reason: opened.reason === "reference_key_unavailable" ? opened.reason : "unopenable" };
    storageKey = opened.storageKey;
  } else {
    // LEGACY: a row written before the seal. Its value is the key itself; it
    // passes the same validator and the same byte gate as an opened one.
    storageKey = stored;
  }
  const ref = appStorageUrlInfo(storageKey);
  if (!ref) return { ok: false, reason: "unopenable" };
  if (!(await authorizeMediaAccess(sc, viewerId, ref.bucket, ref.path))) {
    return { ok: false, reason: "not_authorized" };
  }
  return { ok: true, bucket: ref.bucket, path: ref.path };
}

// ── Reader 2: account deletion's search for the bytes ───────────────────────

/** The paged reader AccountDeletionService hands its collection steps. */
export type EvidencePagedRead = (build: () => any, consume: (rows: any[]) => number) => Promise<number>;

/**
 * Every storage key referenced by THIS ACCOUNT's own evidence rows, for
 * account deletion to remove before erase_intel_for_actor deletes the rows.
 *
 * The rows are read under EVERY value `actor_id` may hold for the account (the
 * account id and each live epoch's 3002 token). Reading `.eq("actor_id",
 * accountId)` alone matched nothing once 3002 tokenised the column, so the
 * bytes of every post-3002 evidence row would have survived the deletion.
 *
 * Returns the opened keys UNVALIDATED: the caller applies its own guard (an
 * allowed bucket, no `..`, and ownerFromPath === the account). A legacy
 * plaintext value is returned as stored, for the same guard. A sealed value
 * that does not open is counted in `unopenable`, and the caller must report it:
 * it is an object this deletion cannot find. Throws when the account's
 * identities cannot be read, because ownership is then unknown, not empty.
 */
export async function collectOwnEvidenceObjectKeys(
  sc: any,
  accountId: string,
  readAll: EvidencePagedRead,
): Promise<{ keys: string[]; unopenable: number }> {
  if (!accountId) throw new Error("evidence object collection: account id is required");
  const identities = await readOwnContributorIdentities(sc, accountId);
  if (!identities.ok) {
    throw new Error(`evidence object collection: contributor identities unreadable (${identities.reason}): ${identities.detail}`);
  }
  const keys: string[] = [];
  let unopenable = 0;
  for (const identity of identities.identities) {
    await readAll(
      () =>
        sc
          .from("intel_evidence")
          .select("observation_id, reference")
          .eq("actor_id", identity)
          .order("id", { ascending: true }),
      (rows) => {
        let n = 0;
        for (const row of rows) {
          // NULL by design for 'text_note' and 'sensor' evidence and for the
          // media seam: those reference no stored object here.
          const stored = typeof row?.reference === "string" ? row.reference.trim() : "";
          if (!stored) continue;
          if (!isSealedEvidenceReference(stored)) {
            keys.push(stored);
            n += 1;
            continue;
          }
          const opened = openEvidenceReference(stored, row?.observation_id);
          if (opened.ok) {
            keys.push(opened.storageKey);
            n += 1;
          } else {
            unopenable += 1;
          }
        }
        return n;
      },
    );
  }
  return { keys, unopenable };
}

// ── Reader 3: the remediation for rows written before the seal ──────────────

/** The SECURITY DEFINER function migration 3360 adds and 3361 drops. */
export const EVIDENCE_REKEY_RPC = "intel_evidence_rekey_reference";

export interface LegacyEvidenceRekeyOutcome {
  apply: boolean;
  /** photo/video rows whose reference is not sealed. */
  legacy: number;
  /** Re-sealed by this run (always 0 on a dry run). */
  rekeyed: number;
  /** Not a key in our own storage, so nothing can be sealed. Needs a person. */
  refused: number;
  /** The RPC failed or found the row changed underneath it. Safe to re-run. */
  failed: number;
}

/**
 * Re-seal every photo/video evidence row that still holds a plaintext key.
 *
 * DRY RUN unless `apply` is true: it then only counts. It never returns or logs
 * a reference, since every legacy value names an account. It READS EVERYTHING
 * FIRST and then writes, because each re-sealed row leaves the filtered set and
 * offset paging would otherwise skip rows. Each write goes through 3360's
 * function, which changes exactly one row, from exactly the value read, to a
 * sealed value. Throws before any write when the key is unavailable.
 *
 * NOT RUN against any database by the lane that wrote it.
 */
export async function rekeyLegacyEvidenceReferences(
  sc: any,
  opts: { apply: boolean; pageSize?: number },
): Promise<LegacyEvidenceRekeyOutcome> {
  const pageSize = Math.max(1, Math.min(opts.pageSize ?? 500, 900));
  const legacyRows: Array<{ id: string; observation_id: string; reference: string }> = [];
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await sc
      .from("intel_evidence")
      .select("id, observation_id, reference")
      .in("evidence_kind", ["photo", "video"])
      .not("reference", "is", null)
      .not("reference", "like", `${EVIDENCE_REFERENCE_PREFIX}%`)
      .order("id", { ascending: true })
      .range(from, from + pageSize - 1);
    if (error) throw new Error(`legacy evidence read failed: ${String(error.message ?? error)}`);
    const rows = (data as any[]) ?? [];
    for (const r of rows) {
      if (typeof r?.reference === "string" && !isSealedEvidenceReference(r.reference)) {
        legacyRows.push({ id: String(r.id), observation_id: String(r.observation_id ?? ""), reference: r.reference });
      }
    }
    if (rows.length < pageSize) break;
  }

  const outcome: LegacyEvidenceRekeyOutcome = { apply: opts.apply, legacy: legacyRows.length, rekeyed: 0, refused: 0, failed: 0 };
  if (!opts.apply || legacyRows.length === 0) return outcome;
  if (!evidenceReferenceKeys()) {
    throw new Error("INTEL_EVIDENCE_REFERENCE_KEY is unset or shorter than 32 characters; nothing was re-sealed");
  }

  for (const row of legacyRows) {
    const ref = appStorageUrlInfo(row.reference);
    const sealed = ref ? sealEvidenceReference(`${ref.bucket}/${ref.path}`, row.observation_id) : null;
    if (!sealed || !sealed.ok) {
      outcome.refused += 1;
      continue;
    }
    const { data, error } = await sc.rpc(EVIDENCE_REKEY_RPC, {
      p_evidence_id: row.id,
      p_legacy_reference: row.reference,
      p_sealed_reference: sealed.reference,
    });
    if (error || data !== true) outcome.failed += 1;
    else outcome.rekeyed += 1;
  }
  return outcome;
}

// ═══════════════════════════════════════════════════════════════════════════
// GATE 2b — WHOSE WORDS MAY KEEP A PHOTO (census-media §39; census-map §45.5)
// ═══════════════════════════════════════════════════════════════════════════
//
// Gate 2 accepts any valid Intelligence Contributions consent, and consent is
// only as wide as its words. The one disclosure in force,
// `intel_contributions_v1`, names Quick Signals and nothing else. The prepared
// `sensing_contributions_v2` (docs/contracts/sensing-consent-disclosure-v2.md)
// is not owner-approved, and its words do not name photos or videos either
// (read 2026-09-27). Keeping a person's photo under words that never mention
// one would record a consent nobody gave.
//
// So a photo or video is kept as evidence only when the contributor's RECORDED
// `consent_version` is listed below, and the list is EMPTY. Today every media
// contribution is refused with `consent_does_not_cover_photos` (HTTP 409), and
// the refusal writes nothing. The request that carries the photo only ever
// attaches evidence to an observation that already exists: it creates no
// observation, and it is refused before any row is read or written. The tap
// the photo would have supported is a separate request on the observation
// arrow, never reaches this gate, and stands on its own.
//
// WHAT TURNS IT ON. An owner step, not a code decision. The owner approves
// disclosure words that name photos and videos kept as evidence. Then ONE
// release ships three things together: that version as the server's
// INTEL_CONSENT_DISCLOSURE_VERSION, its words on the client, and its string in
// this list. No existing version may be added here: none of them says photos.
//
// NOT COVERED HERE: lib/media/mediaEvidenceLink, the media seam's writer, has no
// consent check of any kind. It has no caller and waits on census-media §35.4
// MD65, and it must pass this same gate the day one is wired.
import { getIntelConsentState } from "./intelConsent.js";

/** Disclosure versions whose words name photos and videos kept as evidence. EMPTY: none in force does. */
export const PHOTO_EVIDENCE_CONSENT_VERSIONS: readonly string[] = Object.freeze([] as string[]);

let photoEvidenceConsentVersionsForTests: ReadonlySet<string> | null = null;

/**
 * TEST SEAM ONLY. It lets a suite prove that the gate reads the RECORDED version
 * (rather than refusing everything), by naming a fictional covering version.
 * Product code never calls it; test/intelEvidenceReference.test.ts pins that.
 * Pass null to restore the shipped list.
 */
export function _setPhotoEvidenceConsentVersionsForTests(versions: readonly string[] | null): void {
  photoEvidenceConsentVersionsForTests = versions === null ? null : new Set(versions);
}

export type PhotoEvidenceConsentAnswer =
  | { covered: true }
  | { covered: false; reason: "consent_does_not_cover_photos" | "db_error"; detail: string };

const PHOTO_CONSENT_REFUSAL =
  "The consent you gave covers reports, not photos or videos, so this was not kept. Your report itself is unaffected; send it without the photo.";

/**
 * Does this contributor's recorded disclosure name photos? Fail-closed: no row,
 * no version, a withdrawn or disabled grant, or a version not on the list all
 * answer no. An unreadable consent row answers `db_error` (retryable), because
 * coverage is then unknown rather than refused.
 */
export async function consentCoversPhotoEvidence(sc: any, actorId: string): Promise<PhotoEvidenceConsentAnswer> {
  const allowed = photoEvidenceConsentVersionsForTests ?? new Set(PHOTO_EVIDENCE_CONSENT_VERSIONS);
  // No version names photos, so no recorded version can: refuse without a read.
  if (allowed.size === 0) return { covered: false, reason: "consent_does_not_cover_photos", detail: PHOTO_CONSENT_REFUSAL };
  const read = await getIntelConsentState(sc, actorId);
  if (!read.ok) return { covered: false, reason: "db_error", detail: "consent version lookup" };
  const state = read.state;
  if (state.enabled !== true || state.withdrawnAt || !state.consentVersion || !allowed.has(state.consentVersion)) {
    return { covered: false, reason: "consent_does_not_cover_photos", detail: PHOTO_CONSENT_REFUSAL };
  }
  return { covered: true };
}
