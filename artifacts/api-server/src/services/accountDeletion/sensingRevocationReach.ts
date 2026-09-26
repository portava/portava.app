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
 * ── THE INPUT THE REACH MODULE WANTS: EXACT SINCE 3311, SUBJECT-LEVEL BEFORE
 * `revocationReach(sessions, memories, revokedClaimRefs)` wants the snapshot
 * ids the erased observations fed. Since 3311, `intel_state_snapshots` carries
 * `input_observation_ids` — FORWARD provenance written by the projection
 * (opaque ids naming no contributor; the reverse path towards a person still
 * runs through intel_observations, whose actor_id is a rotating token, and
 * the rows themselves are gone after the erase). The enumeration reads it
 * with an overlap query and reports `provenance: "exact"`. On a database
 * without 3311 the read fails on the unknown column, and the enumeration
 * falls back to SUBJECT granularity (`provenance: "subject"`) — over-
 * inclusive, never "rested on nothing". Both sets are reported; the exact one
 * is what the erasure recompute acts on when it exists.
 *
 * The anonymous store (2315) keeps no per-row provenance by design (§20) and
 * is not read here. Subject granularity, as it always was:
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
 *   memories    OTHER accounts' memory_projections rows whose 3314 `claim_refs`
 *               overlap the affected snapshot set — written by
 *               `services/memoryProjections/sessionMemoryStore` when a session
 *               closes. The departing account's own memories are excluded and
 *               counted: `erase_memory_for_user` removes them in the same run.
 *               On a database WITHOUT 3314 the read fails on the unknown column
 *               and `memoryStore` reads `column_absent` — which is a true
 *               statement that nothing can have been persisted with refs (the
 *               store refuses to write without the column), not "nothing
 *               reached". Any other read failure throws.
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
import type { AffectedMemory, AffectedSnapshot } from "./sensingErasureRecompute.js";

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
  /** Snapshot ids of those subjects — the over-inclusive set. */
  snapshots: number;
  /** Snapshots whose 3311 provenance names one of the account's observations; equals `snapshots` under subject fallback. */
  snapshotsExact: number;
  /** How the revoked claim refs were derived: 3311's provenance, or the pre-3311 subject fallback. */
  provenance: "exact" | "subject";
  /** The account's own observation ids (the erased evidence). Handed to the recompute; never logged. */
  observationIds: string[];
  /** The snapshots the erasure must recompute or retract, keyed for the recompute. */
  affected: AffectedSnapshot[];
  /** Other accounts' sessions on those subjects, one per session id. */
  sessionsConsidered: number;
  /** Of those, the ones whose claim_refs intersect the snapshot set. */
  sessionsReached: number;
  /** The departing account's own sessions, excluded from the count above. */
  ownSessionsExcluded: number;
  /** Other accounts' stored memories whose claim_refs overlap the affected snapshots. */
  memoriesConsidered: number;
  /** Of those, the ones the pure judge finds resting on an affected snapshot. */
  memoriesReached: number;
  /** The departing account's own memories that overlapped — erased by erase_memory_for_user, not counted above. */
  ownMemoriesExcluded: number;
  /** The reached memories, keyed for the erasure's lineage pass. Row ids and refs only; no owner. */
  affectedMemories: AffectedMemory[];
  /** §18.4 stages the reach module reports as touched, in order. */
  stagesReached: SensingLineageStage[];
  /** Whether the memory store could be asked: 3314 present, or absent (nothing persisted with refs). */
  memoryStore: "persisted" | "column_absent";
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

  // 2. The subjects this account observed, and the observation ids themselves
  //    (the evidence the erase is about to remove). One query per identity
  //    (the account id plus at most one token per live epoch), each paged.
  const subjects = new Set<string>();
  const observationIds = new Set<string>();
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
          if (typeof r?.id === "string" && r.id !== "") observationIds.add(r.id);
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
  const observationList = [...observationIds].sort();

  // 3a. Every snapshot of those subjects — the over-inclusive set, always
  //     enumerated so the count is comparable across databases.
  const subjectSnapshots = new Map<string, AffectedSnapshot>();
  for (const part of chunk(subjectList, REACH_IN_LIST_CHUNK)) {
    await readAll(
      () =>
        sc
          .from("intel_state_snapshots")
          .select("id, subject_id, zone_id, claim_type")
          .in("subject_id", part)
          .order("id", { ascending: true }),
      (rows) => {
        for (const r of rows) {
          if (typeof r?.id !== "string" || r.id === "") continue;
          subjectSnapshots.set(r.id, { id: r.id, subjectId: String(r.subject_id ?? ""), zoneId: String(r.zone_id ?? ""), claimType: String(r.claim_type ?? "") });
        }
        return rows.length;
      },
    );
  }

  // 3b. The EXACT set: snapshots whose 3311 provenance names one of the
  //     account's observations. On a pre-3311 database the read fails on the
  //     unknown column; that one failure — and only that one — is the signal
  //     to fall back to the subject set. Any other read failure still throws.
  const exactSnapshots = new Map<string, AffectedSnapshot>();
  let provenance: "exact" | "subject" = "exact";
  try {
    for (const part of chunk(observationList, REACH_IN_LIST_CHUNK)) {
      await readAll(
        () =>
          sc
            .from("intel_state_snapshots")
            .select("id, subject_id, zone_id, claim_type")
            .overlaps("input_observation_ids", part)
            .order("id", { ascending: true }),
        (rows) => {
          for (const r of rows) {
            if (typeof r?.id !== "string" || r.id === "") continue;
            exactSnapshots.set(r.id, { id: r.id, subjectId: String(r.subject_id ?? ""), zoneId: String(r.zone_id ?? ""), claimType: String(r.claim_type ?? "") });
          }
          return rows.length;
        },
      );
    }
  } catch (err) {
    const message = String((err as Error)?.message ?? err);
    if (!/input_observation_ids/.test(message)) throw err;
    provenance = "subject";
  }

  const affected = provenance === "exact" ? [...exactSnapshots.values()] : [...subjectSnapshots.values()];
  const snapshotIds = new Set(affected.map((a) => a.id));

  // 4. Other accounts' sessions on those subjects. Oldest first, so a closed
  //    envelope overwrites the opened one for the same session id.
  const latestBySession = new Map<string, ExperienceSessionEnvelope>();
  let ownSessionsExcluded = 0;
  for (const part of chunk(subjectList, REACH_IN_LIST_CHUNK)) {
    await readAll(
      () =>
        sc
          .from("canonical_events")
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

  // 5. Memories resting on the affected snapshots (3314). Other accounts'
  //    only: the departing account's own are erased by erase_memory_for_user in
  //    the same run, so they are counted and set aside. The owner column is
  //    read only to make that exclusion and is never returned.
  const storedById = new Map<string, AffectedMemory>();
  let ownMemoriesExcluded = 0;
  let memoryStore: "persisted" | "column_absent" = "persisted";
  const snapshotIdList = [...snapshotIds].sort();
  try {
    for (const part of chunk(snapshotIdList, REACH_IN_LIST_CHUNK)) {
      await readAll(
        () =>
          sc
            .from("memory_projections")
            .select("id, user_id, claim_refs")
            .overlaps("claim_refs", part)
            .order("id", { ascending: true }),
        (rows) => {
          for (const r of rows) {
            if (typeof r?.id !== "string" || r.id === "") continue;
            if (r?.user_id === userId) {
              ownMemoriesExcluded += 1;
              continue;
            }
            const refs = Array.isArray(r?.claim_refs) ? (r.claim_refs as unknown[]).filter((x): x is string => typeof x === "string") : [];
            storedById.set(r.id, { id: r.id, claimRefs: refs });
          }
          return rows.length;
        },
      );
    }
  } catch (err) {
    const message = String((err as Error)?.message ?? err);
    if (!/claim_refs/.test(message)) throw err;
    memoryStore = "column_absent";
  }
  const storedMemories = [...storedById.values()];

  // 6. The pure reach, over what could be read.
  const report = revocationReach([...latestBySession.values()], [], snapshotIds, storedMemories);
  const reachedMemoryIds = new Set(report.memories.filter((m) => m.verdict === "reached").map((m) => m.sourceId));

  return {
    via: ids.via,
    identities: ids.identities.length,
    observations,
    subjects: subjects.size,
    snapshots: subjectSnapshots.size,
    snapshotsExact: provenance === "exact" ? exactSnapshots.size : subjectSnapshots.size,
    provenance,
    observationIds: observationList,
    affected,
    sessionsConsidered: latestBySession.size,
    sessionsReached: report.sessions.filter((s) => s.verdict === "reached").length,
    ownSessionsExcluded,
    memoriesConsidered: storedMemories.length,
    memoriesReached: reachedMemoryIds.size,
    ownMemoriesExcluded,
    affectedMemories: storedMemories.filter((m) => reachedMemoryIds.has(m.id)),
    stagesReached: report.stagesReached,
    memoryStore,
  };
}

/**
 * Compile-time tie for the literal `.from("canonical_events")` above. It is a
 * literal, not `SESSION_EVENTS_TABLE`, because check:write-path-columns
 * resolves table names statically and reads an imported constant as a blind
 * spot. If `SESSION_EVENTS_TABLE` ever changes, this line stops compiling
 * (TS2322) before a query can go to the wrong table.
 */
const _sessionEventsTableTie: typeof SESSION_EVENTS_TABLE = "canonical_events";
void _sessionEventsTableTie;
