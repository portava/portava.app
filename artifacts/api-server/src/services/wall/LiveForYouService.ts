/**
 * LiveForYouService — the small, bounded, personalized live strip (spec §4).
 *
 * OWNS: the small personalized live strip. DOES NOT OWN: the underlying live
 * claims (those belong to Live Intelligence; this service only reads the
 * canonical projection through lib/liveClaimRead.ts).
 *
 * Live For You is NOT the feed (spec §4). It answers "is anything happening right
 * now that is unusually relevant to me?" with normally 2–4 items. The hard rules
 * (spec §4) are enforced structurally here:
 *
 *   • No generic city-wide firehose — the strip reads ONLY the viewer-relevant
 *     candidate subjects the caller supplies (saved places, trip stops, places
 *     from the feed the viewer is close to). It never enumerates a city.
 *   • No stale live labels — every claim comes from readLiveClaimEnvelopes, which
 *     drops anything expired, below the live floor, or not privacy-eligible, and
 *     returns [] whenever Live intelligence is not servable at all. A stale claim
 *     therefore simply does not appear (fail-closed; spec §31/§34).
 *   • No exact private-location leakage — envelopes carry decision-exposure
 *     fields only (no coordinates, contributor ids, or exact cohort counts).
 *   • No paid placement masquerading as live — the read path's source-class
 *     truth boundary already forbids that (spec §19/§21).
 *   • Deduplicate against the feed — a subject already shown as a feed object /
 *     context thread is NOT repeated in the strip (spec §4 / §15 liveStrip dedup).
 *
 * The strip refreshes independently of feed pagination (spec §28) and may be
 * ignored entirely — normal scrolling never depends on it.
 */
import {
  readLiveClaimEnvelopes,
  type LiveClaimEnvelope,
} from "../../lib/liveClaimRead.js";
import type {
  FreshnessState,
  LiveForYouItem,
  LiveObjectType,
  PublicPlaceRef,
  WallAction,
} from "../../lib/wallProjection.js";

/** Absolute ceiling on strip size (spec §4: "normally 2–4 items"). */
export const MAX_LIVE_FOR_YOU = 4;

/** How many candidate subjects we will probe at most — a hard bound that keeps
 *  this a personalized strip and not a scan (spec §4: no firehose). */
const MAX_SUBJECT_PROBES = 16;

export interface LiveForYouCandidate {
  /** Canonical subject (place/zone) id the live claim is about. */
  subjectId: string;
  liveObjectType: LiveObjectType;
  subject?: PublicPlaceRef;
}

export interface BuildLiveForYouOptions {
  /** Requested max (clamped to 1..MAX_LIVE_FOR_YOU). Default MAX_LIVE_FOR_YOU. */
  limit?: number;
  /** Subject ids already represented in the feed / context threads — skipped. */
  dedupeSubjectIds?: Set<string>;
  /** Restrict to specific claim types (e.g. ["crowd.level"]). */
  claimTypes?: readonly string[];
  now?: Date;
}

/** Map the read path's live state to the Wall freshness state. */
function freshnessFor(env: LiveClaimEnvelope, now: Date): FreshnessState {
  const valid = Date.parse(env.validUntil);
  if (!Number.isNaN(valid) && valid <= now.getTime()) return "stale";
  return env.state === "live" ? "live" : "recent";
}

/** A short, privacy-safe label. Combines the subject name with a string claim
 *  value when one is present ("An Thuong · busy"); never emits coordinates. */
function labelFor(cand: LiveForYouCandidate, env: LiveClaimEnvelope): string {
  const name = cand.subject?.name ?? "Nearby";
  const v = env.value as unknown;
  const valueStr =
    typeof v === "string"
      ? v
      : v && typeof v === "object" && typeof (v as any).level === "string"
        ? (v as any).level
        : null;
  return valueStr ? `${name} · ${valueStr}` : name;
}

/** The single tap action for a live item, by kind (spec §4/§8). */
function actionFor(cand: LiveForYouCandidate): WallAction | undefined {
  switch (cand.liveObjectType) {
    case "place_state":
    case "event_state":
      return { type: "see_place", label: "See place", targetType: "place", targetId: cand.subjectId };
    case "hidden_gem":
      return { type: "explore", label: "Explore", targetType: "place", targetId: cand.subjectId };
    case "social_presence":
      return { type: "see_who", label: "See who", targetType: "place", targetId: cand.subjectId };
    case "buddy":
      return { type: "book_buddy", label: "See Buddy", targetType: "place", targetId: cand.subjectId };
    case "trip_signal":
      return { type: "open_map", label: "See on map", targetType: "place", targetId: cand.subjectId };
    default:
      return undefined;
  }
}

/**
 * Build the Live For You strip for a viewer from a bounded set of relevant
 * candidate subjects. Returns 0..limit items (limit ≤ 4). Never throws; any read
 * failure yields fewer/zero items rather than an error, so the feed renders
 * regardless (spec §34 / TABLE 5: Live Intelligence unavailable ⇒ degrade the
 * strip, social feed stays normal).
 */
export async function buildLiveForYou(
  sc: any,
  candidates: LiveForYouCandidate[],
  opts: BuildLiveForYouOptions = {},
): Promise<LiveForYouItem[]> {
  const limit = Math.max(1, Math.min(opts.limit ?? MAX_LIVE_FOR_YOU, MAX_LIVE_FOR_YOU));
  const now = opts.now ?? new Date();
  const dedupe = opts.dedupeSubjectIds ?? new Set<string>();

  // De-duplicate candidate subjects, drop any already shown in the feed, and cap
  // the probe count so this is a personalized strip, never a city scan.
  const probe: LiveForYouCandidate[] = [];
  const seenSubjects = new Set<string>();
  for (const c of candidates) {
    if (!c.subjectId || seenSubjects.has(c.subjectId) || dedupe.has(c.subjectId)) continue;
    seenSubjects.add(c.subjectId);
    probe.push(c);
    if (probe.length >= MAX_SUBJECT_PROBES) break;
  }
  if (probe.length === 0) return [];

  // Read all probed subjects in parallel (each read is itself fully gated).
  const envelopesPerSubject = await Promise.all(
    probe.map((c) =>
      readLiveClaimEnvelopes(sc, c.subjectId, { claimTypes: opts.claimTypes, now }).catch(
        () => [] as LiveClaimEnvelope[],
      ),
    ),
  );

  // Assemble in candidate order (deterministic), taking the best/current claim
  // per subject, until we hit the strip bound.
  const out: LiveForYouItem[] = [];
  for (let i = 0; i < probe.length && out.length < limit; i++) {
    const cand = probe[i];
    const env = envelopesPerSubject[i][0]; // read path returns best/current first
    if (!env) continue;
    const freshness = freshnessFor(env, now);
    if (freshness === "stale") continue; // belt-and-braces; read path already drops expired
    out.push({
      id: env.id,
      liveObjectType: cand.liveObjectType,
      subjectId: cand.subjectId,
      subject: cand.subject,
      label: labelFor(cand, env),
      freshness,
      confidence: env.confidence,
      state: env.state === "live" ? "live" : "emerging",
      // §10: carried so the strip can say "Reports differ" where it would have
      // said Live/Emerging. The read path already capped state under 'material'.
      conflictState: env.conflictState,
      observedAt: env.observedAt,
      validUntil: env.validUntil,
      action: actionFor(cand),
    });
  }
  return out;
}
