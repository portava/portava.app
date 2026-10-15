/**
 * §25 replay FROM SNAPSHOTS — a Memory's fact history (§3 `memory_snapshots`,
 * migration 3811) read back version by version and checked against the rules
 * that wrote it and against the Memory as it is now.
 *
 * SPEC: docs/specs/Portava_Highlights_Memories_Development_Architecture_Spec_v1.txt
 *       :172-173 "memory_snapshots — Versioned fact/evidence snapshots for
 *       replay"; §25 (:641-642) "Memory behavior must be replayable from
 *       structured evidence, commands, and engine versions. This is essential to
 *       diagnose false memories and migration changes."
 * CENSUS: census-highlights-memories H35 (B58 cluster MEM-SNAPSHOTS, §BO).
 *
 * TWO THINGS LIVE HERE, AND ONLY ONE OF THEM TOUCHES A DATABASE
 * ============================================================
 * 1. `replayMemoryFromSnapshots(client, …)` — the replay. It reads a Memory's
 *    stored versions through the same reader the server uses
 *    (services/memory/memorySnapshots.ts readSnapshotRows) on ANY supabase-shaped
 *    client: the service client, the db suite's SQL adapter over the real chain
 *    (src/test/db/memorySnapshots.db.test.ts), or the deterministic world below.
 *    A history REPLAYS when its versions are contiguous (a pruned prefix only
 *    when exactly the cap is kept), every version holds facts and nothing else,
 *    names an extractor this code can read, differs from the version before it,
 *    belongs to the Memory's owner, and the newest is the Memory as it is now; a
 *    deleted Memory replays only with NO version left (§21). Anything else
 *    DIVERGES, and the divergence says which version and why.
 * 2. The certification scenarios — `runSnapshotReplayCertification()`, printed by
 *    check:memory-certification (src/scripts/checkMemoryCertification.ts). They
 *    run in a deterministic in-memory world (no clock, no network), so the
 *    TRIGGER is a TypeScript stand-in (`recordSnapshotInWorld`) and the guard is
 *    modelled in `snapshotWorldClient`. That is a model of 3811, not 3811: the db
 *    suite executes the SQL on the full chain and holds `snapshotFactsOf` equal
 *    to it, and sql/rehearsals/3811_01_memory_snapshots.sql rehearses it. Each
 *    scenario carries its expected verdict; the four CONTROL_ scenarios are
 *    histories the replay must REFUSE, so a replay that accepted everything
 *    would fail certification.
 */

import {
  MEMORY_SNAPSHOT_CAP,
  MEMORY_SNAPSHOT_CAUSE_KEYS,
  MEMORY_SNAPSHOT_EXTRACTOR_VERSION,
  changedFactKeys,
  eraseSnapshotsForDeletedMemory,
  factsEqual,
  readSnapshotRows,
  snapshotFactsOf,
  whitelistFacts,
  type SnapshotFacts,
  type SnapshotRow,
} from "../memory/memorySnapshots.js";

export const SNAPSHOT_REPLAY_VERSION = "memory-snapshot-replay@1";

/** Extractors whose facts this replay knows how to read. */
export const KNOWN_SNAPSHOT_EXTRACTORS: readonly string[] = Object.freeze([MEMORY_SNAPSHOT_EXTRACTOR_VERSION]);

export type SnapshotReplayStatus = "REPLAYED" | "DIVERGED" | "NO_SURFACE" | "UNREADABLE";

export interface SnapshotReplay {
  readonly memory_id: string;
  readonly status: SnapshotReplayStatus;
  /** The versions read, oldest first. */
  readonly versions: readonly number[];
  /** The first version kept, when the cap pruned the ones before it. */
  readonly pruned_before: number | null;
  /** Per version, the fact keys that changed from the version before it. */
  readonly timeline: ReadonlyArray<{ readonly version: number; readonly changed: readonly string[] }>;
  /** The newest version's facts (whitelisted), or null with no version. */
  readonly final_facts: SnapshotFacts | null;
  readonly extractors: readonly string[];
  /** Empty when REPLAYED. */
  readonly divergences: readonly string[];
  /** Findings that are not divergences (a Memory with no version yet; an item count that moved without a Memory write). */
  readonly notes: readonly string[];
  readonly detail: string;
}

/** The Memory as it is now: its row (null once hard-deleted) and its item count. */
export interface ReplayCanonical {
  readonly row: Readonly<Record<string, unknown>> | null;
  readonly itemCount: number;
}

function outcome(memoryId: string, status: SnapshotReplayStatus, detail: string, rest: Partial<SnapshotReplay> = {}): SnapshotReplay {
  return {
    memory_id: memoryId, status, versions: [], pruned_before: null, timeline: [], final_facts: null,
    extractors: [], divergences: [], notes: [], detail, ...rest,
  };
}

/**
 * Replay one Memory's history. `canonical`, when given, is the Memory now; the
 * newest version must equal its facts. Never throws.
 */
export async function replayMemoryFromSnapshots(
  client: unknown,
  input: { memoryId: string; ownerId: string; canonical?: ReplayCanonical },
): Promise<SnapshotReplay> {
  const read = await readSnapshotRows(client, input.memoryId);
  if (read.state === "absent") return outcome(input.memoryId, "NO_SURFACE", `memory_snapshots is not deployed here (3811 unapplied): ${read.detail}`);
  if (read.state === "unreadable") return outcome(input.memoryId, "UNREADABLE", read.detail);

  const rows = read.rows;
  const divergences: string[] = [];
  const notes: string[] = [];
  const timeline: Array<{ version: number; changed: string[] }> = [];
  const extractors = new Set<string>();
  let prev: SnapshotFacts | null = null;
  let prevVersion: number | null = null;

  for (const r of rows) {
    const v = Number(r.version);
    if (r.owner_id !== input.ownerId) divergences.push(`version ${v} belongs to ${String(r.owner_id)}, not to the Memory's owner`);
    if (prevVersion !== null && v !== prevVersion + 1) divergences.push(`gap: version ${prevVersion} is followed by version ${v} — a version was removed out of order`);
    const { facts, dropped } = whitelistFacts(r.facts);
    if (dropped.length > 0) divergences.push(`version ${v} stores what is not a fact: ${dropped.join(", ")}`);
    const ev = r.engine_versions !== null && typeof r.engine_versions === "object" ? (r.engine_versions as Record<string, unknown>) : {};
    const extractor = typeof ev["snapshot"] === "string" ? ev["snapshot"] : "<none>";
    extractors.add(extractor);
    if (!KNOWN_SNAPSHOT_EXTRACTORS.includes(extractor)) divergences.push(`version ${v} was written by extractor ${extractor}, which this replay cannot read`);
    const causeKeys = r.cause !== null && typeof r.cause === "object" ? Object.keys(r.cause as object) : ["<not an object>"];
    const strayCause = causeKeys.filter((k) => !(MEMORY_SNAPSHOT_CAUSE_KEYS as readonly string[]).includes(k));
    if (strayCause.length > 0) divergences.push(`version ${v} carries a cause that is not a command or correction id: ${strayCause.join(", ")}`);
    if (prev !== null && factsEqual(prev, facts)) divergences.push(`version ${v} repeats version ${prevVersion}: a version is written only when the facts change`);
    timeline.push({ version: v, changed: changedFactKeys(prev, facts) });
    prev = facts;
    prevVersion = v;
  }

  const versions = rows.map((r) => Number(r.version));
  const first = versions[0] ?? null;
  if (rows.length > MEMORY_SNAPSHOT_CAP) divergences.push(`${rows.length} versions are kept, more than the cap of ${MEMORY_SNAPSHOT_CAP}`);
  if (first !== null && first > 1 && rows.length !== MEMORY_SNAPSHOT_CAP) {
    divergences.push(`the history starts at version ${first} with ${rows.length} kept: the cap prunes only to exactly ${MEMORY_SNAPSHOT_CAP}, so a prefix was removed by something else`);
  }

  if (input.canonical) {
    const row = input.canonical.row;
    if (row === null || row["state"] === "deleted") {
      if (rows.length > 0) divergences.push(`the Memory is ${row === null ? "gone" : "deleted"} and still has ${rows.length} version(s): §21 has not purged its history`);
    } else if (rows.length === 0) {
      notes.push("no version is recorded: the Memory has not been written since 3811 was applied (no backfill, Q-H35)");
    } else {
      const now = snapshotFactsOf(row, input.canonical.itemCount);
      const differing = changedFactKeys(prev, now);
      const factual = differing.filter((k) => k !== "item_count");
      if (factual.length > 0) divergences.push(`the newest version (${versions[versions.length - 1]}) is not the Memory as it is: ${factual.join(", ")} differ — a write was not recorded`);
      else if (differing.includes("item_count")) notes.push(`the item count moved from ${String(prev?.["item_count"])} to ${input.canonical.itemCount} without a Memory write (items are counted when the Memory is written)`);
    }
  }

  return outcome(input.memoryId, divergences.length > 0 ? "DIVERGED" : "REPLAYED",
    divergences.length > 0 ? divergences.join(" | ") : `${rows.length} version(s) replayed${first !== null && first > 1 ? `, versions before ${first} pruned by the cap` : ""}`,
    {
      versions,
      pruned_before: first !== null && first > 1 ? first : null,
      timeline,
      final_facts: prev,
      extractors: [...extractors].sort(),
      divergences,
      notes,
    });
}

// ── The deterministic world: 3811 modelled in TypeScript ─────────────────────

/** A world: Memories by id (their item counts alongside) and the stored versions. */
export interface SnapshotWorld {
  memories: Map<string, Record<string, unknown>>;
  itemCounts: Map<string, number>;
  snapshots: SnapshotRow[];
  /** 3811 unapplied: the table answers 42P01. */
  absent?: boolean;
}

/**
 * 3811's memory_snapshot_record(), modelled: a deleted Memory writes nothing;
 * facts equal to the newest version write nothing; otherwise the next version,
 * then the oldest beyond the cap are pruned. `at` is a literal (no clock).
 */
export function recordSnapshotInWorld(
  world: SnapshotWorld,
  row: Record<string, unknown>,
  opts: { at: string; cause?: Record<string, string> },
): void {
  const id = String(row["id"]);
  world.memories.set(id, { ...row });
  if (row["state"] === "deleted") return;
  const facts = snapshotFactsOf(row, world.itemCounts.get(id) ?? 0);
  const mine = world.snapshots.filter((s) => s.memory_id === id);
  const newest = mine.reduce<SnapshotRow | null>((a, s) => (a === null || s.version > a.version ? s : a), null);
  if (newest !== null && factsEqual(whitelistFacts(newest.facts).facts, facts)) return;
  const version = (newest?.version ?? 0) + 1;
  world.snapshots.push({
    memory_id: id, owner_id: String(row["owner_id"]), version, facts: { ...facts },
    engine_versions: { snapshot: MEMORY_SNAPSHOT_EXTRACTOR_VERSION }, cause: { ...(opts.cause ?? {}) }, created_at: opts.at,
  });
  world.snapshots = world.snapshots.filter((s) => !(s.memory_id === id && s.version <= version - MEMORY_SNAPSHOT_CAP));
}

/**
 * The narrow supabase surface memorySnapshots.ts uses (select / eq / delete /
 * limit, resolving `{ data, error }`, never throwing), over a world. DELETE obeys
 * 3811's guard as modelled: a version of a LIVE Memory goes only when it is at
 * least the cap below the newest; otherwise the statement fails whole (42501).
 */
export function snapshotWorldClient(world: SnapshotWorld): { from: (t: string) => unknown } {
  function chain(table: string) {
    const preds: Array<(r: SnapshotRow) => boolean> = [];
    let mode: "select" | "delete" = "select";
    let limitN: number | null = null;
    const run = async (): Promise<{ data: unknown; error: { code: string; message: string } | null }> => {
      if (table !== "memory_snapshots") return { data: null, error: { code: "42P01", message: `relation "public.${table}" does not exist` } };
      if (world.absent) return { data: null, error: { code: "42P01", message: 'relation "public.memory_snapshots" does not exist' } };
      const hit = world.snapshots.filter((r) => preds.every((p) => p(r)));
      if (mode === "delete") {
        for (const r of hit) {
          const m = world.memories.get(r.memory_id);
          const live = m !== undefined && m["state"] !== "deleted";
          const newest = Math.max(...world.snapshots.filter((s) => s.memory_id === r.memory_id).map((s) => s.version));
          if (live && r.version > newest - MEMORY_SNAPSHOT_CAP) {
            return { data: null, error: { code: "42501", message: "memory_snapshots: a version of a live Memory is deleted only by the cap, by the §21 erasure of the deleted Memory, or with its account (3811)" } };
          }
        }
        world.snapshots = world.snapshots.filter((r) => !hit.includes(r));
        return { data: hit.map((r) => ({ version: r.version })), error: null };
      }
      const rows = hit.map((r) => ({ ...r }));
      return { data: limitN === null ? rows : rows.slice(0, limitN), error: null };
    };
    const q: Record<string, unknown> = {
      select() { return q; },
      delete() { mode = "delete"; return q; },
      eq(column: string, value: unknown) { preds.push((r) => (r as unknown as Record<string, unknown>)[column] === value); return q; },
      limit(n: number) { limitN = n; return q; },
      then(onF: (v: unknown) => unknown, onR?: (e: unknown) => unknown) { return run().then(onF, onR); },
    };
    return q;
  }
  return { from: (t: string) => chain(t) };
}

// ── The certification scenarios ──────────────────────────────────────────────

const OWNER = "c0000000-0000-4000-8000-000000000001";
const MEM = "c0000000-0000-4000-8000-0000000003b1";

/** A Memory row with every column present, as the full chain has it. */
function memoryRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: MEM, owner_id: OWNER, title: "Market morning", caption: "the best bánh mì", visibility: "only_me", state: "published",
    allowed_user_ids: [], hidden_user_ids: [], trip_id: null, event_id: null, place_id: "fsq:market",
    starts_at: "2026-05-01T08:00:00.000Z", ends_at: null, created_at: "2026-05-01T09:00:00.000Z", updated_at: "2026-05-01T09:00:00.000Z",
    location_city: "Hoi An", location_country: "Vietnam", location_lat: 15.877, location_lng: 108.335, canonical_location_id: null,
    location_precision: "venue", source_mode: "USER_CREATED", memory_type: "MOMENT", place_display_name_at_occurrence: "Central Market",
    ...over,
  };
}

function freshWorld(): SnapshotWorld {
  return { memories: new Map(), itemCounts: new Map([[MEM, 2]]), snapshots: [] };
}

/** Write the Memory's states in order through the modelled trigger, one literal instant each. */
function write(world: SnapshotWorld, states: Array<Record<string, unknown>>): Record<string, unknown> {
  let row = memoryRow();
  states.forEach((over, i) => {
    row = { ...row, ...over };
    recordSnapshotInWorld(world, row, { at: `2026-05-0${1 + (i % 8)}T10:00:${String(i % 60).padStart(2, "0")}.000Z` });
  });
  return row;
}

export const SNAPSHOT_REPLAY_SCENARIO_IDS = [
  "PLACE_HISTORY",
  "CAP_KEEPS_NEWEST",
  "DELETED_MEMORY_PURGED",
  "PURGE_REFUSED_WHILE_LIVE",
  "NOT_DEPLOYED",
  "CONTROL_GAP",
  "CONTROL_NON_FACT_KEY",
  "CONTROL_STALE_NEWEST",
  "CONTROL_DELETED_NOT_PURGED",
] as const;
export type SnapshotReplayScenarioId = (typeof SNAPSHOT_REPLAY_SCENARIO_IDS)[number];

export interface SnapshotReplayOutcome {
  readonly id: SnapshotReplayScenarioId;
  readonly census_id: "H35";
  readonly expected: SnapshotReplayStatus;
  /** CERTIFIED when the replay's verdict and every expectation held. */
  readonly status: "CERTIFIED" | "DIVERGED";
  readonly replay: SnapshotReplay;
  /** Empty when CERTIFIED. */
  readonly divergences: readonly string[];
}

interface Scenario {
  expected: SnapshotReplayStatus;
  /** For a control: the divergence it must be refused FOR, so a refusal for another reason is not a pass. */
  because?: RegExp;
  run: () => Promise<{ replay: SnapshotReplay; checks: string[] }>;
}

const sameList = (a: readonly unknown[], b: readonly unknown[]) => JSON.stringify(a) === JSON.stringify(b);

const SCENARIOS: Record<SnapshotReplayScenarioId, Scenario> = {
  // The H35 story: created at one place, moved twice, a title edit in between.
  PLACE_HISTORY: {
    expected: "REPLAYED",
    run: async () => {
      const w = freshWorld();
      const now = write(w, [{}, { title: "a new title", caption: "a new caption", location_lat: 15.9 }, { place_id: "fsq:bridge", place_display_name_at_occurrence: "Japanese Bridge" }, { place_id: "fsq:lantern", place_display_name_at_occurrence: "Lantern Street" }]);
      const replay = await replayMemoryFromSnapshots(snapshotWorldClient(w), { memoryId: MEM, ownerId: OWNER, canonical: { row: now, itemCount: 2 } });
      const checks: string[] = [];
      if (!sameList(replay.versions, [1, 2, 3])) checks.push(`versions ${JSON.stringify(replay.versions)}, expected [1,2,3] (a title, caption or coordinate edit is not a fact)`);
      const places = w.snapshots.map((s) => (s.facts as Record<string, unknown>)["place_id"]);
      if (!sameList(places, ["fsq:market", "fsq:bridge", "fsq:lantern"])) checks.push(`place history ${JSON.stringify(places)}`);
      if (!sameList(replay.timeline[2]?.changed ?? [], ["place_display_name_at_occurrence", "place_id"])) checks.push(`version 3 changed ${JSON.stringify(replay.timeline[2]?.changed)}`);
      if (JSON.stringify(w.snapshots).match(/bánh mì|new title|new caption|15\.9|15\.877|108\.335|Hoi An/)) checks.push("a version carries a title, caption, coordinate or city");
      return { replay, checks };
    },
  },
  // 56 states: the oldest six go, the newest fifty replay and end at the Memory.
  CAP_KEEPS_NEWEST: {
    expected: "REPLAYED",
    run: async () => {
      const w = freshWorld();
      const now = write(w, Array.from({ length: 56 }, (_, i) => ({ place_id: `fsq:stop-${i}` })));
      const replay = await replayMemoryFromSnapshots(snapshotWorldClient(w), { memoryId: MEM, ownerId: OWNER, canonical: { row: now, itemCount: 2 } });
      const checks: string[] = [];
      if (replay.versions.length !== MEMORY_SNAPSHOT_CAP || replay.versions[0] !== 7 || replay.versions[replay.versions.length - 1] !== 56) {
        checks.push(`kept ${replay.versions.length} versions ${replay.versions[0]}..${replay.versions[replay.versions.length - 1]}, expected ${MEMORY_SNAPSHOT_CAP} versions 7..56`);
      }
      if (replay.final_facts?.["place_id"] !== "fsq:stop-55") checks.push("the newest version is not the newest place");
      return { replay, checks };
    },
  },
  // §21: soft delete (no version), then the real purge; the replay finds nothing.
  DELETED_MEMORY_PURGED: {
    expected: "REPLAYED",
    run: async () => {
      const w = freshWorld();
      const now = write(w, [{}, { place_id: "fsq:bridge" }, { state: "deleted" }]);
      const checks: string[] = [];
      if (w.snapshots.length !== 2) checks.push(`the soft delete wrote a version (${w.snapshots.length} kept)`);
      const purge = await eraseSnapshotsForDeletedMemory(snapshotWorldClient(w), { memoryId: MEM });
      if (purge.state !== "done" || purge.purged !== 2) checks.push(`the §21 purge answered ${JSON.stringify(purge)}`);
      const replay = await replayMemoryFromSnapshots(snapshotWorldClient(w), { memoryId: MEM, ownerId: OWNER, canonical: { row: now, itemCount: 2 } });
      if (replay.versions.length !== 0) checks.push(`${replay.versions.length} version(s) outlived the purge`);
      return { replay, checks };
    },
  },
  // The purge on a LIVE Memory fails whole (the guard), and the history is intact.
  PURGE_REFUSED_WHILE_LIVE: {
    expected: "REPLAYED",
    run: async () => {
      const w = freshWorld();
      const now = write(w, [{}, { visibility: "friends_only" }]);
      const purge = await eraseSnapshotsForDeletedMemory(snapshotWorldClient(w), { memoryId: MEM });
      const checks: string[] = purge.state === "failed" ? [] : [`a purge of a live Memory's history answered ${purge.state}`];
      const replay = await replayMemoryFromSnapshots(snapshotWorldClient(w), { memoryId: MEM, ownerId: OWNER, canonical: { row: now, itemCount: 2 } });
      if (!sameList(replay.versions, [1, 2])) checks.push(`versions after the refused purge: ${JSON.stringify(replay.versions)}`);
      return { replay, checks };
    },
  },
  // 3811 unapplied: nothing to replay, said as such — never an empty history.
  NOT_DEPLOYED: {
    expected: "NO_SURFACE",
    run: async () => {
      const w = { ...freshWorld(), absent: true };
      return { replay: await replayMemoryFromSnapshots(snapshotWorldClient(w), { memoryId: MEM, ownerId: OWNER }), checks: [] };
    },
  },
  // CONTROLS — histories the replay must refuse.
  CONTROL_GAP: {
    expected: "DIVERGED",
    because: /^gap: version 1 is followed by version 3/,
    run: async () => {
      const w = freshWorld();
      const now = write(w, [{}, { place_id: "fsq:bridge" }, { place_id: "fsq:lantern" }]);
      w.snapshots = w.snapshots.filter((s) => s.version !== 2);
      return { replay: await replayMemoryFromSnapshots(snapshotWorldClient(w), { memoryId: MEM, ownerId: OWNER, canonical: { row: now, itemCount: 2 } }), checks: [] };
    },
  },
  CONTROL_NON_FACT_KEY: {
    expected: "DIVERGED",
    because: /stores what is not a fact: caption/,
    run: async () => {
      const w = freshWorld();
      const now = write(w, [{}]);
      w.snapshots = w.snapshots.map((s) => ({ ...s, facts: { ...(s.facts as object), caption: "the best bánh mì" } }));
      return { replay: await replayMemoryFromSnapshots(snapshotWorldClient(w), { memoryId: MEM, ownerId: OWNER, canonical: { row: now, itemCount: 2 } }), checks: [] };
    },
  },
  CONTROL_STALE_NEWEST: {
    expected: "DIVERGED",
    because: /is not the Memory as it is: place_id differ/,
    run: async () => {
      const w = freshWorld();
      write(w, [{}]);
      const moved = memoryRow({ place_id: "fsq:unrecorded" }); // written with the trigger off
      return { replay: await replayMemoryFromSnapshots(snapshotWorldClient(w), { memoryId: MEM, ownerId: OWNER, canonical: { row: moved, itemCount: 2 } }), checks: [] };
    },
  },
  CONTROL_DELETED_NOT_PURGED: {
    expected: "DIVERGED",
    because: /deleted and still has 1 version/,
    run: async () => {
      const w = freshWorld();
      const now = write(w, [{}, { state: "deleted" }]);
      return { replay: await replayMemoryFromSnapshots(snapshotWorldClient(w), { memoryId: MEM, ownerId: OWNER, canonical: { row: now, itemCount: 2 } }), checks: [] };
    },
  },
};

export async function runSnapshotReplayCertification(): Promise<SnapshotReplayOutcome[]> {
  const out: SnapshotReplayOutcome[] = [];
  for (const id of SNAPSHOT_REPLAY_SCENARIO_IDS) {
    const s = SCENARIOS[id];
    const { replay, checks } = await s.run();
    const divergences = [
      ...(replay.status === s.expected ? [] : [`the replay answered ${replay.status}, expected ${s.expected}: ${replay.detail}`]),
      ...(s.because && !replay.divergences.some((d) => s.because!.test(d)) ? [`refused, but not for ${String(s.because)}: ${replay.detail}`] : []),
      ...checks,
    ];
    out.push({ id, census_id: "H35", expected: s.expected, status: divergences.length === 0 ? "CERTIFIED" : "DIVERGED", replay, divergences });
  }
  return out;
}

/** Stable, diffable: no timestamps, no durations. */
export function formatSnapshotReplayReport(outcomes: readonly SnapshotReplayOutcome[]): string {
  const lines: string[] = [];
  lines.push(`§25 replay from snapshots (§3 memory_snapshots, migration 3811) — ${SNAPSHOT_REPLAY_VERSION}, extractor ${MEMORY_SNAPSHOT_EXTRACTOR_VERSION}, cap ${MEMORY_SNAPSHOT_CAP}`);
  for (const o of outcomes) {
    lines.push(`  ${o.census_id.padEnd(5)} ${o.status.padEnd(9)} ${o.id}  (replay ${o.replay.status}, expected ${o.expected})`);
    lines.push(`        versions ${o.replay.versions.length === 0 ? "none" : `${o.replay.versions[0]}..${o.replay.versions[o.replay.versions.length - 1]}`}${o.replay.pruned_before ? `  pruned before ${o.replay.pruned_before}` : ""}  ·  ${o.replay.detail}`);
    for (const n of o.replay.notes) lines.push(`        note: ${n}`);
    for (const d of o.divergences) lines.push(`        DIVERGED: ${d}`);
  }
  lines.push("  CEILING: this world models 3811's trigger and guard in TypeScript; src/test/db/memorySnapshots.db.test.ts runs the replay over the SQL itself on the full chain (CI's local-db job), and 3811 is applied to no database.");
  return lines.join("\n");
}
