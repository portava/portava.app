/**
 * wallMoments — Sensing §9: "Wall consumes meaningful state transitions, not
 * repeated snapshots of unchanged state", and the server-built WallMoment
 * "with subject, transition, occurred_at, relevance window, reason, truth
 * class, freshness and expiry".
 *
 * ── WHAT A TRANSITION IS, AND WHAT IT IS NOT ─────────────────────────────────
 * A transition is a CHANGE of a served value between two projections of the
 * same subject and claim type: busy → packed, building → peaking, a safety
 * notice appearing, a queue lengthening. The same value projected again is
 * not a transition and produces no moment — that is the whole of the row's
 * "not repeated snapshots". The CURRENT value is a LiveClaimEnvelope from
 * lib/liveClaimRead (gated there: flags, promoted scope, privacy eligibility,
 * the live floor, the truth boundary); the PREVIOUS value comes from the
 * projection's own append-only record, intel_state_snapshot_versions (2273),
 * read privacy-eligible only, and is used for one thing: to say whether and
 * when the current value became the current value. A previous value is never
 * served on its own.
 *
 * ── THE TRANSITION VOCABULARY ────────────────────────────────────────────────
 * §9's examples: "place warming → building, event starting, saved place
 * peaking, crowd shift, hidden gem emerging, Trip opportunity opening, safety
 * notice activation". This module covers the place-state family — the ones a
 * live claim can evidence. Event starting, hidden gem emerging and Trip
 * opportunities are other producers' objects and are not invented here.
 *
 * ── TRUTH TRAVELS WITH THE MOMENT ────────────────────────────────────────────
 * A moment carries the §5.1 block of the envelope that evidences it, through
 * the same derivation every other surface uses (lib/liveEnvelopeTruth), and a
 * safety activation is never claimed from anything but a served
 * `unsafe_density` reading — the specialist-only crowd level no contributor
 * surface can emit (lib/intelContracts SPECIALIST_ONLY_CROWD_LEVELS).
 *
 * PURE. No I/O, no clock of its own; `nowMs` is injected.
 */
import type { LiveClaimEnvelope } from "./liveClaimRead.js";
import type { TruthMetadata } from "./experienceTruth.js";
import { truthOfEnvelope } from "./liveEnvelopeTruth.js";

/** §9's place-state transitions. */
export const WALL_TRANSITIONS = [
  "warming",
  "building",
  "peaking",
  "cooling",
  "crowd_shift",
  "vibe_change",
  "queue_change",
  "safety_notice_activated",
  "safety_notice_cleared",
] as const;
export type WallTransitionKind = (typeof WALL_TRANSITIONS)[number];

/** A previous projection of one claim type, privacy-eligible, from the versions record. */
export interface PreviousReading {
  claimType: string;
  value: unknown;
  observedAt: string;
  /** When the projection wrote this version — the instant the value became current. */
  generatedAt: string;
}

export interface WorldTransition {
  kind: WallTransitionKind;
  claimType: string;
  from: string | null;
  to: string | null;
  /** The instant the current value became current, or the current observation when unknown. */
  occurredAt: string;
  /** The envelope that evidences the current side. */
  envelope: LiveClaimEnvelope;
}

export interface WallMoment {
  id: string;
  subject: { kind: "place"; id: string };
  transition: { kind: WallTransitionKind; claimType: string; from: string | null; to: string | null };
  occurredAt: string;
  /** The window in which this moment is relevant: from the change until the evidence expires. */
  relevanceWindow: { from: string; until: string };
  reason: { code: WallTransitionKind; text: string };
  truthClass: TruthMetadata["truthClass"];
  confidence: TruthMetadata["confidence"];
  freshness: TruthMetadata["freshness"];
  coverage: TruthMetadata["coverage"];
  expiresAt: string;
  /** The snapshot id the moment rests on. Opaque; never a contributor. */
  claimRef: string;
}

const TRAJECTORY_TRANSITION: Readonly<Record<string, WallTransitionKind | null>> = {
  emerging: "warming",
  building: "building",
  peaking: "peaking",
  stable: null,
  fragmenting: "cooling",
  relocating: "cooling",
  declining: "cooling",
  ending: "cooling",
};

const SCALAR_KEY: Readonly<Record<string, string>> = {
  "crowd.level": "level",
  crowd: "level",
  "crowd.trajectory": "trajectory",
  "vibe.state": "state",
  "queue.wait": "minMinutes",
};

/** The comparable scalar of a claim value, as a string; null when the value has none. */
export function claimScalar(claimType: string, value: unknown): string | null {
  const key = SCALAR_KEY[claimType];
  if (!key) return null;
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const v = (value as Record<string, unknown>)[key];
    if (typeof v === "string") return v;
    if (typeof v === "number" && Number.isFinite(v)) return String(v);
  }
  return null;
}

function kindOf(claimType: string, from: string | null, to: string | null): WallTransitionKind | null {
  if (claimType === "crowd.level" || claimType === "crowd") {
    if (to === "unsafe_density") return "safety_notice_activated";
    if (from === "unsafe_density") return "safety_notice_cleared";
    return "crowd_shift";
  }
  if (claimType === "crowd.trajectory") return to !== null && Object.prototype.hasOwnProperty.call(TRAJECTORY_TRANSITION, to) ? TRAJECTORY_TRANSITION[to]! : null;
  if (claimType === "vibe.state") return "vibe_change";
  if (claimType === "queue.wait") return "queue_change";
  return null;
}

/**
 * Detect the transitions a subject's current envelopes evidence against its
 * previous readings. One transition at most per claim type; none when the
 * value did not change or no previous reading exists to change from.
 */
export function detectTransitions(
  current: readonly LiveClaimEnvelope[],
  previous: readonly PreviousReading[],
): WorldTransition[] {
  const out: WorldTransition[] = [];
  for (const env of current) {
    const to = claimScalar(env.claimType, env.value);
    if (to === null) continue;
    // Oldest first, so the walk finds the LAST differing value and the FIRST
    // reading after it that already carried the current value.
    const history = previous
      .filter((p) => p.claimType === env.claimType && Number.isFinite(Date.parse(p.generatedAt)))
      .sort((a, b) => Date.parse(a.generatedAt) - Date.parse(b.generatedAt));
    let lastDifferent: PreviousReading | null = null;
    let becameCurrentAt: string | null = null;
    for (const p of history) {
      const v = claimScalar(p.claimType, p.value);
      if (v === null) continue;
      if (v !== to) { lastDifferent = p; becameCurrentAt = null; }
      else if (lastDifferent !== null && becameCurrentAt === null) becameCurrentAt = p.generatedAt;
    }
    if (lastDifferent === null) continue; // no change on record — not a moment
    const from = claimScalar(lastDifferent.claimType, lastDifferent.value);
    const kind = kindOf(env.claimType, from, to);
    if (kind === null) continue;
    out.push({ kind, claimType: env.claimType, from, to, occurredAt: becameCurrentAt ?? env.observedAt, envelope: env });
  }
  return out;
}

const CROWD_WORDS: Readonly<Record<string, string>> = {
  dead: "empty", quiet: "quiet", moderate: "moderately busy", busy: "busy", packed: "packed", unsafe_density: "at an unsafe density",
};

function reasonText(t: WorldTransition): string {
  switch (t.kind) {
    case "warming": return "Warming up";
    case "building": return "Building";
    case "peaking": return "Peaking";
    case "cooling": return "Cooling";
    case "crowd_shift": return `Crowd ${CROWD_WORDS[t.from ?? ""] ?? t.from ?? "unknown"} → ${CROWD_WORDS[t.to ?? ""] ?? t.to ?? "unknown"}`;
    case "vibe_change": return `Vibe reported ${t.from ?? "unknown"} → ${t.to ?? "unknown"}`;
    case "queue_change": return `Queue ${t.from ?? "?"} → ${t.to ?? "?"} min`;
    case "safety_notice_activated": return "Safety notice: unsafe density reported";
    case "safety_notice_cleared": return "Safety notice cleared";
  }
}

/** Build the WallMoment for one transition. The window is the change → the evidence's expiry. */
export function buildWallMoment(subjectId: string, t: WorldTransition, nowMs: number): WallMoment {
  const truth = truthOfEnvelope(t.envelope, nowMs);
  return {
    id: `moment:${subjectId}:${t.claimType}:${t.occurredAt}:${t.to ?? ""}`,
    subject: { kind: "place", id: subjectId },
    transition: { kind: t.kind, claimType: t.claimType, from: t.from, to: t.to },
    occurredAt: t.occurredAt,
    relevanceWindow: { from: t.occurredAt, until: t.envelope.validUntil },
    reason: { code: t.kind, text: reasonText(t) },
    truthClass: truth.truthClass,
    confidence: truth.confidence,
    freshness: truth.freshness,
    coverage: truth.coverage,
    expiresAt: t.envelope.validUntil,
    claimRef: t.envelope.id,
  };
}

/** All moments for one subject: detect, build, newest first, expired dropped. */
export function buildWallMoments(
  subjectId: string,
  current: readonly LiveClaimEnvelope[],
  previous: readonly PreviousReading[],
  nowMs: number,
): WallMoment[] {
  return detectTransitions(current, previous)
    .map((t) => buildWallMoment(subjectId, t, nowMs))
    .filter((m) => Date.parse(m.expiresAt) > nowMs)
    .sort((a, b) => Date.parse(b.occurredAt) - Date.parse(a.occurredAt));
}
