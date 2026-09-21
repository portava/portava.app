/**
 * liveReference — Sensing §12: what Telegraph SHARES when it shares live
 * intelligence. A canonical REFERENCE to a server-built object — the
 * ExperienceState of a place, a WorldMoment at it, a SafetyNotice on it —
 * never a copy of its prose. The recipient resolves the reference against the
 * CURRENT state through the one gated read path, and the answer says whether
 * the state has changed since it was shared (§12 "shared live objects may
 * indicate that state changed since sharing").
 *
 * ── WHAT A REFERENCE CARRIES ─────────────────────────────────────────────────
 * The subject (a place: id and name), the kind, and per claim the snapshot id
 * (the provenance pointer lib/liveClaimRead already serves), the projection's
 * own version id at share time when the record could be read, the comparable
 * VALUE at share time (lib/wallMoments.claimScalar — the baseline "changed
 * since" is measured from, not a sentence about it), the observation time,
 * the validity horizon and the §5.1 truth block composed weakest-wins
 * (lib/liveEnvelopeTruth). A world_moment reference carries the transition
 * (kind, claim type, from → to, occurred_at) exactly as lib/wallMoments
 * detected it. Nothing person-shaped: no contributor, no count, no cohort.
 *
 * The one human line, `text`, names the subject and the kind and NOTHING of
 * the state ("Live state of Han Market") — so a client that renders only the
 * line can never present the value as it was at share time as if it were
 * current. A value belongs to `claims[].value`, which a resolving client shows
 * next to the current one with the change between them.
 *
 * ── THE FOURTH OBJECT ────────────────────────────────────────────────────────
 * §12 names four: ExperienceState, Opportunity, WorldMoment, SafetyNotice. The
 * tree holds a canonical producer for three (lib/mapExperienceState,
 * lib/wallMoments, lib/mapProducers/safetyNoticeProducer). No canonical
 * Opportunity object exists anywhere (census S56, NOT-BUILT), so no kind here
 * names one: a reference to an object with no producer would be a reference
 * to prose, which is the thing this module exists to refuse.
 *
 * ── SAFETY NOTICES RESOLVE THROUGH THE SAME GATE ─────────────────────────────
 * The map's readSafetyNotices deliberately skips the per-scope pilot allowlist
 * (a withheld safety notice is what §5 forbids) but is approved for the map
 * gateway only (src/test/gatewayBypassGuard.test.ts). A Telegraph reference
 * resolves through lib/liveClaimRead, which applies that allowlist, so a
 * specialist-reviewed safety claim at a venue outside the promoted scopes is
 * not referenceable from a conversation while it is visible on the map. That
 * is recorded as a ceiling, not hidden behind a bypass.
 *
 * PURE. No I/O, no clock of its own, no labels for any number.
 */
import { z } from "zod";
import type { LiveClaimEnvelope } from "./liveClaimRead.js";
import type { TruthMetadata } from "./experienceTruth.js";
import { truthOfEnvelopes } from "./liveEnvelopeTruth.js";
import { WALL_TRANSITIONS, claimScalar, type WallTransitionKind, type WorldTransition } from "./wallMoments.js";

export const LIVE_REFERENCE_TYPE = "live_reference" as const;
export const LIVE_REFERENCE_SCHEMA_VERSION = 1 as const;
/** The messages row a reference rides in: the `card` type the hidden-gem share uses, its own subtype. */
export const LIVE_REFERENCE_MSG_TYPE = "card" as const;
export const LIVE_REFERENCE_MSG_SUBTYPE = "live_reference" as const;

export const LIVE_REFERENCE_KINDS = ["experience_state", "world_moment", "safety_notice"] as const;
export type LiveReferenceKind = (typeof LIVE_REFERENCE_KINDS)[number];
/** §12's fourth object. No canonical producer exists (S56); no kind names it — see the header. */
export const UNREFERENCEABLE_SPEC_OBJECTS = ["opportunity"] as const;

/** The claim types an ExperienceState / WorldMoment reference is evidenced by — the Wall's set. */
export const EXPERIENCE_REFERENCE_CLAIM_TYPES = ["crowd.level", "crowd.trajectory", "vibe.state", "queue.wait"] as const;
/** The one claim that constitutes a safety notice today — the same pair the map producer reads. */
export const SAFETY_REFERENCE_CLAIM_TYPE = "crowd.level";
export const SAFETY_REFERENCE_LEVEL = "unsafe_density";
export const LIVE_REFERENCE_CLAIM_TYPES: Readonly<Record<LiveReferenceKind, readonly string[]>> = {
  experience_state: EXPERIENCE_REFERENCE_CLAIM_TYPES,
  world_moment: EXPERIENCE_REFERENCE_CLAIM_TYPES,
  safety_notice: [SAFETY_REFERENCE_CLAIM_TYPE],
};
/** A sender's own words, bounded. Never the state's. */
export const LIVE_REFERENCE_NOTE_MAX = 280;

const KIND_WORD: Readonly<Record<LiveReferenceKind, string>> = {
  experience_state: "Live state",
  world_moment: "Live moment",
  safety_notice: "Safety notice",
};

export interface LiveReferenceClaim {
  claimType: string;
  /** intel_state_snapshots row id at share time — the provenance pointer. Opaque; never a contributor. */
  snapshotId: string;
  /** intel_state_snapshot_versions id whose value matched at share time; null when the record could not say. */
  versionId: string | null;
  /** The comparable value at share time — the baseline, not a sentence. */
  value: string | null;
  observedAt: string;
  validUntil: string;
  state: LiveClaimEnvelope["state"];
  band: LiveClaimEnvelope["band"];
  sourceClass: LiveClaimEnvelope["sourceClass"];
  conflictState: LiveClaimEnvelope["conflictState"];
}

export interface LiveReferenceMoment {
  kind: WallTransitionKind;
  claimType: string;
  from: string | null;
  to: string | null;
  occurredAt: string;
}

export interface LiveReference {
  type: typeof LIVE_REFERENCE_TYPE;
  schemaVersion: typeof LIVE_REFERENCE_SCHEMA_VERSION;
  kind: LiveReferenceKind;
  subject: { type: "place"; id: string; name: string | null };
  claims: LiveReferenceClaim[];
  /** world_moment only. */
  moment: LiveReferenceMoment | null;
  /** §5.1 block of the referenced state at share time, weakest-wins over its claims. */
  truth: TruthMetadata;
  sharedAt: string;
  /** The sender's own words, or null. */
  note: string | null;
  /** The one human line: subject and kind, never a value. */
  text: string;
}

export interface BuildLiveReferenceInput {
  kind: LiveReferenceKind;
  subject: { id: string; name: string | null };
  /** The CURRENT envelopes, as lib/liveClaimRead served them. */
  envelopes: readonly LiveClaimEnvelope[];
  /** claim type → { versionId, value } of the newest privacy-eligible version; null when unread. */
  versions: ReadonlyMap<string, { id: string; value: unknown }> | null;
  /** world_moment: the transition to reference (the caller picks the newest). */
  transition?: WorldTransition | null;
  note?: string | null;
  nowMs: number;
}

export type BuildLiveReferenceResult =
  | { ok: true; reference: LiveReference }
  | { ok: false; refusal: "nothing_to_reference" };

function isSafetyEnvelope(e: LiveClaimEnvelope): boolean {
  return e.claimType === SAFETY_REFERENCE_CLAIM_TYPE && claimScalar(e.claimType, e.value) === SAFETY_REFERENCE_LEVEL;
}

/** The envelopes a kind is evidenced by; [] when the kind has nothing to point at. */
export function selectReferenceEnvelopes(
  kind: LiveReferenceKind,
  envelopes: readonly LiveClaimEnvelope[],
  transition?: WorldTransition | null,
): LiveClaimEnvelope[] {
  switch (kind) {
    case "safety_notice":
      return envelopes.filter(isSafetyEnvelope);
    case "world_moment":
      return transition ? [transition.envelope] : [];
    case "experience_state":
      return envelopes.filter(
        (e) => (EXPERIENCE_REFERENCE_CLAIM_TYPES as readonly string[]).includes(e.claimType) && claimScalar(e.claimType, e.value) !== null,
      );
  }
}

/**
 * The version id a claim is pinned to: the newest privacy-eligible version of
 * its type, and only when that version's value IS the served value — a record
 * that has not caught up with the current state pins nothing (null), so the
 * pointer is never to a version that says something else.
 */
export function pinVersionId(
  e: LiveClaimEnvelope,
  versions: ReadonlyMap<string, { id: string; value: unknown }> | null,
): string | null {
  if (!versions) return null;
  const v = versions.get(e.claimType);
  if (!v) return null;
  return claimScalar(e.claimType, v.value) === claimScalar(e.claimType, e.value) ? v.id : null;
}

function toClaim(e: LiveClaimEnvelope, versions: BuildLiveReferenceInput["versions"]): LiveReferenceClaim {
  return {
    claimType: e.claimType,
    snapshotId: e.id,
    versionId: pinVersionId(e, versions),
    value: claimScalar(e.claimType, e.value),
    observedAt: e.observedAt,
    validUntil: e.validUntil,
    state: e.state,
    band: e.band,
    sourceClass: e.sourceClass,
    conflictState: e.conflictState,
  };
}

function cleanNote(note: string | null | undefined): string | null {
  if (typeof note !== "string") return null;
  const t = note.trim();
  if (t === "") return null;
  return t.length > LIVE_REFERENCE_NOTE_MAX ? t.slice(0, LIVE_REFERENCE_NOTE_MAX) : t;
}

/** The one human line. Subject and kind only — a value never enters it. */
export function referenceText(kind: LiveReferenceKind, subjectName: string | null): string {
  const name = subjectName && subjectName.trim() !== "" ? subjectName.trim() : "a place";
  return `${KIND_WORD[kind]} of ${name}`;
}

export function buildLiveReference(input: BuildLiveReferenceInput): BuildLiveReferenceResult {
  const selected = selectReferenceEnvelopes(input.kind, input.envelopes, input.transition);
  if (selected.length === 0) return { ok: false, refusal: "nothing_to_reference" };
  const t = input.kind === "world_moment" ? input.transition ?? null : null;
  const reference: LiveReference = {
    type: LIVE_REFERENCE_TYPE,
    schemaVersion: LIVE_REFERENCE_SCHEMA_VERSION,
    kind: input.kind,
    subject: { type: "place", id: input.subject.id, name: input.subject.name ?? null },
    claims: selected.map((e) => toClaim(e, input.versions)),
    moment: t ? { kind: t.kind, claimType: t.claimType, from: t.from, to: t.to, occurredAt: t.occurredAt } : null,
    truth: truthOfEnvelopes(selected, input.nowMs),
    sharedAt: new Date(input.nowMs).toISOString(),
    note: cleanNote(input.note),
    text: referenceText(input.kind, input.subject.name),
  };
  return { ok: true, reference };
}

/** The messages.body a reference is stored as. JSON, like the other card bodies. */
export function liveReferenceBody(reference: LiveReference): string {
  return JSON.stringify(reference);
}

// ── Parsing a stored reference back ───────────────────────────────────────────

const isoString = z.string().refine((s) => Number.isFinite(Date.parse(s)), "not an instant");
const claimSchema = z.object({
  claimType: z.string().min(1),
  snapshotId: z.string().min(1),
  versionId: z.string().min(1).nullable(),
  value: z.string().nullable(),
  observedAt: isoString,
  validUntil: isoString,
  state: z.enum(["live", "emerging", "typical", "unknown"]),
  band: z.string().min(1),
  sourceClass: z.string().min(1),
  conflictState: z.string().min(1),
});
const momentSchema = z.object({
  kind: z.enum(WALL_TRANSITIONS),
  claimType: z.string().min(1),
  from: z.string().nullable(),
  to: z.string().nullable(),
  occurredAt: isoString,
});
const truthSchema = z.object({
  truthClass: z.string().min(1),
  confidence: z.string().min(1),
  freshness: z.string().min(1),
  coverage: z.string().min(1),
  provenance: z.array(z.string()),
});
const referenceSchema = z.object({
  type: z.literal(LIVE_REFERENCE_TYPE),
  schemaVersion: z.literal(LIVE_REFERENCE_SCHEMA_VERSION),
  kind: z.enum(LIVE_REFERENCE_KINDS),
  subject: z.object({ type: z.literal("place"), id: z.string().uuid(), name: z.string().nullable() }),
  claims: z.array(claimSchema).min(1),
  moment: momentSchema.nullable(),
  truth: truthSchema,
  sharedAt: isoString,
  note: z.string().max(LIVE_REFERENCE_NOTE_MAX).nullable(),
  text: z.string().min(1),
});

/** A stored body → a reference, or null when it is not one this module wrote. Never throws. */
export function parseLiveReference(raw: unknown): LiveReference | null {
  let obj: unknown = raw;
  if (typeof raw === "string") {
    try {
      obj = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  const r = referenceSchema.safeParse(obj);
  if (!r.success) return null;
  return r.data as unknown as LiveReference;
}

// ── Changed since sharing ─────────────────────────────────────────────────────

export const REFERENCE_CHANGES = ["unchanged", "reaffirmed", "changed", "expired", "withdrawn", "added"] as const;
export type ReferenceChange = (typeof REFERENCE_CHANGES)[number];
/** The changes that mean "the state is not what was shared". */
export const CHANGES_THAT_DIFFER: readonly ReferenceChange[] = ["changed", "expired", "withdrawn", "added"];

export interface ClaimComparison {
  claimType: string;
  change: ReferenceChange;
  sharedValue: string | null;
  currentValue: string | null;
  sharedObservedAt: string | null;
  currentObservedAt: string | null;
  currentSnapshotId: string | null;
}

export type LiveReferenceComparison =
  | {
      readable: true;
      /** True when any claim differs from what was shared. */
      changedSinceShare: boolean;
      claims: ClaimComparison[];
      /** world_moment: is the transition's `to` still the current value? */
      momentStillCurrent: boolean | null;
      ageMinutes: number;
      refusal: null;
    }
  | {
      readable: false;
      /** Unknowable: the current state could not be read. Never false by default. */
      changedSinceShare: null;
      claims: [];
      momentStillCurrent: null;
      ageMinutes: number;
      refusal: "live_intelligence_unavailable" | "error";
    };

export function ageMinutesOf(sharedAt: string, nowMs: number): number {
  const t = Date.parse(sharedAt);
  if (!Number.isFinite(t)) return 0;
  return Math.max(0, Math.round((nowMs - t) / 60_000));
}

export function refusedComparison(
  reference: LiveReference,
  refusal: "live_intelligence_unavailable" | "error",
  nowMs: number,
): LiveReferenceComparison {
  return { readable: false, changedSinceShare: null, claims: [], momentStillCurrent: null, ageMinutes: ageMinutesOf(reference.sharedAt, nowMs), refusal };
}

function compareOne(shared: LiveReferenceClaim, current: LiveClaimEnvelope | undefined, nowMs: number): ClaimComparison {
  const base = {
    claimType: shared.claimType,
    sharedValue: shared.value,
    sharedObservedAt: shared.observedAt,
    currentValue: current ? claimScalar(current.claimType, current.value) : null,
    currentObservedAt: current ? current.observedAt : null,
    currentSnapshotId: current ? current.id : null,
  };
  if (!current) {
    const until = Date.parse(shared.validUntil);
    return { ...base, change: Number.isFinite(until) && nowMs > until ? "expired" : "withdrawn" };
  }
  if (base.currentValue !== shared.value) return { ...base, change: "changed" };
  const newer = current.id !== shared.snapshotId || Date.parse(current.observedAt) > Date.parse(shared.observedAt);
  return { ...base, change: newer ? "reaffirmed" : "unchanged" };
}

/**
 * The shared reference against the CURRENT envelopes (which the caller read
 * through the gate). Per shared claim: the same value on the same evidence is
 * `unchanged`; the same value on newer evidence is `reaffirmed`; a different
 * value is `changed`; no current claim is `expired` past the shared horizon
 * and `withdrawn` before it. A current claim of a type the reference did not
 * carry (within the kind's types) is `added`. The state has changed since
 * sharing when any claim is changed / expired / withdrawn / added.
 */
export function compareLiveReference(
  reference: LiveReference,
  current: readonly LiveClaimEnvelope[],
  nowMs: number,
): LiveReferenceComparison {
  const byType = new Map<string, LiveClaimEnvelope>();
  for (const e of current) if (!byType.has(e.claimType)) byType.set(e.claimType, e);

  const claims: ClaimComparison[] = reference.claims.map((c) => compareOne(c, byType.get(c.claimType), nowMs));
  const sharedTypes = new Set(reference.claims.map((c) => c.claimType));
  const kindTypes = LIVE_REFERENCE_CLAIM_TYPES[reference.kind];
  if (reference.kind !== "world_moment") {
    for (const e of current) {
      if (sharedTypes.has(e.claimType) || !kindTypes.includes(e.claimType)) continue;
      const v = claimScalar(e.claimType, e.value);
      if (v === null) continue;
      if (reference.kind === "safety_notice" && v !== SAFETY_REFERENCE_LEVEL) continue;
      claims.push({
        claimType: e.claimType,
        change: "added",
        sharedValue: null,
        currentValue: v,
        sharedObservedAt: null,
        currentObservedAt: e.observedAt,
        currentSnapshotId: e.id,
      });
    }
  }

  let momentStillCurrent: boolean | null = null;
  if (reference.moment) {
    const e = byType.get(reference.moment.claimType);
    momentStillCurrent = e ? claimScalar(e.claimType, e.value) === reference.moment.to : false;
  }

  return {
    readable: true,
    changedSinceShare: claims.some((c) => CHANGES_THAT_DIFFER.includes(c.change)),
    claims,
    momentStillCurrent,
    ageMinutes: ageMinutesOf(reference.sharedAt, nowMs),
    refusal: null,
  };
}
