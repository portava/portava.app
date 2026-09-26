/**
 * sensingRevocationReach — the PRODUCTION caller for S112's last two stages.
 *
 * ── WHAT THE CENSUS SAID WAS MISSING ─────────────────────────────────────────
 * census-sensing §22.2: `services/memoryProjections/sessionRevocationReach`
 * exists, is pure, and *"its only importer is a test"*. §22.3 restated the row:
 * *"S112 RED WHEN — a production (non-test) caller invokes
 * sessionRevocationReach, AND the memory_projection path it depends on is
 * enabled. WHO: a lane for the caller, then the flag."* This module is the
 * caller. The flag is not this module's to flip.
 *
 * ── WHERE A REVOCATION ACTUALLY HAPPENS IN PRODUCTION ────────────────────────
 * There is exactly one production path that revokes canonical intel evidence:
 * account deletion, through `erase_intel_for_actor(uuid)` (2130, rebuilt by
 * 2278 / 3002 / 3003). The anonymous path's `purge_sensing_contributions_for_token()`
 * has no route and no caller. So the reach is enumerated HERE, inside the
 * deletion run, and it must run BEFORE the erase — afterwards the observations
 * that name the subjects are gone and the question can no longer be asked.
 *
 * ── THE INPUT THE REACH MODULE WANTS DOES NOT EXIST, AND WHAT IS DONE ABOUT IT
 * `revocationReach(sessions, memories, revokedClaimRefs)` wants the snapshot
 * ids the erased observations fed. `intel_state_snapshots` (2130) records
 * `source_count` and `distinct_actors` and NO input provenance — there is no
 * observation→snapshot link anywhere in the schema, and adding one would be a
 * standing reverse path from a snapshot back towards its contributors, which
 * §20 / spec §17 forbid for the anonymous store. So exact provenance is not
 * available and is not fabricated. The enumeration runs at SUBJECT granularity:
 *
 *   identities  every value `actor_id` may hold for this account — the account
 *               id (pre-3002 rows) plus one contributor token per live epoch
 *               (3310's `intel_contributor_tokens_for_actor`), read the way the
 *               evidence-ownership gate reads them;
 *   subjects    the distinct `subject_id`s of the account's own observations;
 *   snapshots   every snapshot of those subjects — treated as the revoked
 *               claim refs. OVER-INCLUSIVE by construction: a snapshot of the
 *               same subject built from other people's observations counts too.
 *               A recomputation owner told "this may rest on erased evidence"
 *               can recompute cheaply; one told "unaffected" wrongly cannot
 *               recover. When in doubt, reach.
 *   sessions    every ExperienceSession (canonical_events, `subject_kind =
 *               'place'`) on those subjects, by OTHER accounts — the departing
 *               account's own sessions are excluded and counted, because the
 *               deletion handles them itself and counting them as "reached"
 *               would inflate the figure with rows that are being removed.
 *   memories    NONE, and this is a measured fact rather than an omission: the
 *               S92 bridge's `NormalizedEvidence` — the only record that carries
 *               `provenance_json.claim_refs` — is never persisted.
 *               `memoryProjectionScheduler.runSessionMemoryBridge` returns
 *               verdicts and `runMemoryProjectionPass` projects through
 *               `project_all_memory`, which reads no claim_refs. There is no
 *               store to enumerate, so `memoryStore` says so out loud instead
 *               of reporting an empty list as "nothing reached".
 *
 * ── FAIL CLOSED, LIKE EVERY OTHER READ IN THE DELETION RUN ───────────────────
 * Any unreadable precondition THROWS, so the deletion STEP fails and warns.
 * Returning "reached nothing" on a failed read would be the defect
 * `failOpenAccountDeletionReads.test.ts` exists to keep out of this service.
 * The reads go through the caller's paged reader — the ONE pager the service
 * has — so a large contributor cannot be silently truncated to a first page.
 *
 * ── WHAT THIS DOES NOT DO ────────────────────────────────────────────────────
 * It deletes, retracts and recomputes nothing. 2130:449-452 rules that derived
 * claims and snapshots survive an erasure and defers recomputation to IG-04.
 * This module answers the enumeration question and hands back counts and
 * stages; it never serves, stores or logs another account's session ids.
 */
import { readOwnContributorIdentities } from "../../lib/intelConsent.js";
import { SESSION_EVENTS_TABLE, SESSION_VERBS } from "../../lib/experienceSessionStore.js";
import { isExperienceSessionEnvelope, type ExperienceSessionEnvelope } from "../../lib/experienceSession.js";
import { revocationReach, type SensingLineageStage } from "../memoryProjections/sessionRevocationReach.js";

/**
 * The service's paged reader, typed structurally so this module can be tested
 * with any pager that keeps the contract: `build` returns a FRESH builder per
 * page, `consume` returns how many things the page contributed.
 */
export type PagedRead = (build: () => any, consume: (rows: any[]) => number) => Promise<number>;

/** PostgREST `in.(…)` lists ride in the URL; same chunk the service uses. */
export const REACH_IN_LIST_CHUNK = 200;

export interface SensingRevocationReachOutcome {
  /** How this account's contributor identities were derived. */
  via: "token_rpc" | "account_id";
  /** Account id plus tokens considered. */
  identities: number;
  /** The account's own observation rows found under those identities. */
  observations: number;
  /** Distinct subjects those observations named. */
  subjects: number;
  /** Snapshot ids of those subjects, treated as the revoked claim refs. */
  snapshots: number;
  /** Other accounts' sessions on those subjects, one per session id. */
  sessionsConsidered: number;
  /** Of those, the ones whose claim_refs intersect the snapshot set. */
  sessionsReached: number;
  /** The departing account's own sessions, excluded from the count above. */
  ownSessionsExcluded: number;
  /** §18.4 stages the reach module reports as touched, in order. */
  stagesReached: SensingLineageStage[];
  /** Why the memory half is empty — a fact about the tree, not this run. */
  memoryStore: "none_persisted";
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * Enumerate what the coming `erase_intel_for_actor(userId)` reaches. Read-only.
 * Throws on any unreadable precondition; see the header for why.
 */
export async function enumerateSensingRevocationReach(
  sc: any,
  userId: string,
  readAll: PagedRead,
): Promise<SensingRevocationReachOutcome> {
  if (!userId) throw new Error("sensing revocation reach: user id is required");

  // 1. Which stored actor_id values are this account's. The bridge refuses
  //    rather than guesses when the store's shape cannot be read; so do we.
  const ids = await readOwnContributorIdentities(sc, userId);
  if (!ids.ok) {
    throw new Error(`sensing revocation reach: contributor identities unreadable (${ids.reason}): ${ids.detail}`);
  }

  // 2. The subjects this account observed. One query per identity (the account
  //    id plus at most one token per live epoch), each paged.
  const subjects = new Set<string>();
  let observations = 0;
  for (const identity of ids.identities) {
    observations += await readAll(
      () =>
        sc
          .from("intel_observations")
          .select("id, subject_id")
          .eq("actor_id", identity)
          .order("id", { ascending: true }),
      (rows) => {
        for (const r of rows) {
          // Post-3002 `subject_id` is nullable (`unknown`, `temporary_world_object`
          // — S111). A subjectless observation feeds no snapshot and reaches
          // nothing through this thread.
          if (typeof r?.subject_id === "string" && r.subject_id !== "") subjects.add(r.subject_id);
        }
        return rows.length;
      },
    );
  }
  const subjectList = [...subjects].sort();

  // 3. Every snapshot of those subjects — the over-inclusive revoked set.
  const snapshotIds = new Set<string>();
  for (const part of chunk(subjectList, REACH_IN_LIST_CHUNK)) {
    await readAll(
      () =>
        sc
          .from("intel_state_snapshots")
          .select("id, subject_id")
          .in("subject_id", part)
          .order("id", { ascending: true }),
      (rows) => {
        for (const r of rows) if (typeof r?.id === "string" && r.id !== "") snapshotIds.add(r.id);
        return rows.length;
      },
    );
  }

  // 4. Other accounts' sessions on those subjects. Oldest first, so a closed
  //    envelope overwrites the opened one for the same session id.
  const latestBySession = new Map<string, ExperienceSessionEnvelope>();
  let ownSessionsExcluded = 0;
  for (const part of chunk(subjectList, REACH_IN_LIST_CHUNK)) {
    await readAll(
      () =>
        sc
          .from(SESSION_EVENTS_TABLE)
          .select("id, actor_id, subject_id, payload, occurred_at")
          .in("verb", [...SESSION_VERBS])
          .eq("subject_kind", "place")
          .in("subject_id", part)
          .order("occurred_at", { ascending: true })
          .order("id", { ascending: true }),
      (rows) => {
        for (const r of rows) {
          const raw = (r?.payload ?? {})["experience_session"];
          if (!isExperienceSessionEnvelope(raw)) continue;
          if (r?.actor_id === userId) {
            ownSessionsExcluded += 1;
            continue;
          }
          latestBySession.set(raw.session_id, raw);
        }
        return rows.length;
      },
    );
  }

  // 5. The pure reach, over what could be read. The memory list is empty for
  //    the reason the header gives, and the outcome names it.
  const report = revocationReach([...latestBySession.values()], [], snapshotIds);

  return {
    via: ids.via,
    identities: ids.identities.length,
    observations,
    subjects: subjects.size,
    snapshots: snapshotIds.size,
    sessionsConsidered: latestBySession.size,
    sessionsReached: report.sessions.filter((s) => s.verdict === "reached").length,
    ownSessionsExcluded,
    stagesReached: report.stagesReached,
    memoryStore: "none_persisted",
  };
}
