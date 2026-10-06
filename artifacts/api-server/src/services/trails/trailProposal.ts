/**
 * trailProposal — the serialised half of `11` §3 "propose Trail"
 * (census-discovery DC-03, §61).
 *
 * `TrailService.proposeTrail` runs `02` §5's four canonicalization checks in
 * TypeScript over the catalogue it reads, and that is still the answer on the
 * non-racing path. It cannot be the DECISION: two proposals racing each other
 * each read a catalogue that does not yet hold the other, so two near-duplicates
 * with different slugs could both be admitted (§51.6). The decision is taken by
 * `public.trail_propose` (migration 3415), where the insert is: it locks every
 * title token of the proposal, re-reads the same comparison set, re-runs the
 * same four checks and the declared parent's waiver in SQL, and inserts in the
 * same READ COMMITTED transaction. Any two proposals that could refuse each
 * other share a title token, so they are serialised, and the second sees the
 * first.
 *
 * FAIL CLOSED. Where 3415 is not applied the function does not exist, and
 * creation is refused as `unavailable` (503) rather than falling back to an
 * unserialised insert: a fallback would reopen the race exactly on the
 * deployments that have not been migrated, and nothing would say so.
 */
import type { TrailCreationCheck, TrailCreationRefusal } from "../../lib/discoveryTrailObject.js";

export interface TrailProposalInput {
  /** Trimmed, as proposeTrail stores it. */
  title: string;
  /** Trimmed and lowercased, as proposeTrail stores it; null for none. */
  destination: string | null;
  description: string | null;
  parentTrailId: string | null;
  proposerId: string | null;
}

export type TrailProposalCommit =
  | { kind: "created"; trail: Record<string, unknown> }
  | { kind: "refused"; refusals: TrailCreationRefusal[]; suggestedParentTrailId: string | null }
  /** The declared parent was archived or removed between the pre-check and the decision. */
  | { kind: "invalid_parent" }
  /** 3975 (census-discovery §84): the proposer has started TRAIL_PROPOSALS_PER_DAY Trails in the last 24 hours, counted under a per-proposer lock. */
  | { kind: "rate_limited" }
  /** 3415 is not applied here. Creation is refused, never done unserialised. */
  | { kind: "unavailable" }
  | { kind: "error"; error: { code?: unknown; message?: unknown } };

const CHECKS: ReadonlySet<string> = new Set<TrailCreationCheck>([
  "uncanonicalisable_title", "duplicate_title_similarity", "destination_overlap",
  "semantic_overlap", "existing_parent_child",
]);

/**
 * "The function is not there": PostgREST's schema-cache miss for a function
 * (PGRST202), Postgres's undefined_function (42883), and the relation misses
 * TrailService already treats as "not deployed" (42P01 / PGRST205).
 */
export function isMissingProposalFunction(error: { code?: unknown; message?: unknown } | null | undefined): boolean {
  if (!error) return false;
  const code = String(error.code ?? "");
  if (code === "PGRST202" || code === "42883" || code === "42P01" || code === "PGRST205") return true;
  const msg = String(error.message ?? "").toLowerCase();
  return msg.includes("trail_propose") && (msg.includes("could not find the function") || msg.includes("does not exist"));
}

function refusalsFrom(raw: unknown): TrailCreationRefusal[] | null {
  if (!Array.isArray(raw)) return null;
  const out: TrailCreationRefusal[] = [];
  for (const r of raw as any[]) {
    if (!r || typeof r !== "object" || !CHECKS.has(String(r.check))) return null;
    out.push({
      check: r.check as TrailCreationCheck,
      conflictsWith: typeof r.conflictsWith === "string" ? r.conflictsWith : null,
      similarity: typeof r.similarity === "number" ? r.similarity : Number(r.similarity ?? 0),
    });
  }
  return out;
}

/**
 * One call to `public.trail_propose`. The answer is parsed strictly: a shape
 * this file does not recognise is an `error`, never a creation, because a
 * created Trail the caller cannot see would be the worst kind of silent success.
 */
export async function commitTrailProposal(sc: any, input: TrailProposalInput): Promise<TrailProposalCommit> {
  let result: { data: unknown; error: any };
  try {
    result = await sc.rpc("trail_propose", {
      p_title: input.title,
      p_destination: input.destination,
      p_description: input.description,
      p_parent_trail_id: input.parentTrailId,
      p_created_by: input.proposerId,
    });
  } catch (e) {
    return { kind: "error", error: { message: e instanceof Error ? e.message : String(e) } };
  }
  const { data, error } = result ?? { data: null, error: { message: "no response" } };
  if (error) return isMissingProposalFunction(error) ? { kind: "unavailable" } : { kind: "error", error };

  const body = (data && typeof data === "object" ? data : null) as Record<string, any> | null;
  switch (body?.outcome) {
    case "created":
      if (body.trail && typeof body.trail === "object" && typeof body.trail.id === "string") {
        return { kind: "created", trail: body.trail as Record<string, unknown> };
      }
      break;
    case "refused": {
      const refusals = refusalsFrom(body.refusals);
      if (refusals) {
        return {
          kind: "refused", refusals,
          suggestedParentTrailId: typeof body.suggestedParentTrailId === "string" ? body.suggestedParentTrailId : null,
        };
      }
      break;
    }
    case "invalid_parent":
      return { kind: "invalid_parent" };
    case "rate_limited":
      return { kind: "rate_limited" };
    default:
      break;
  }
  return { kind: "error", error: { code: "unrecognised_answer", message: "trail_propose answered a shape this client does not know" } };
}
