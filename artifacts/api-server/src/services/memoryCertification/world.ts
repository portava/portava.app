/**
 * Memory certification — the deterministic world a fixture is.
 *
 * SPEC: Portava Highlights / Memories Development Architecture Specification v1
 *       §25 "Replay, Testing, and Certification"
 *       (docs/specs/Portava_Highlights_Memories_Development_Architecture_Spec_v1.txt:641)
 *       "Memory behavior must be replayable from structured evidence, commands,
 *       and engine versions."
 *
 * CENSUS: docs/architecture/census-highlights-memories.md — H224-H253 (§25's
 *         twelve canonical certification fixtures, nine hard invariant tests and
 *         nine property/chaos scenarios). Every one of them was NOT-BUILT before
 *         this module; the census section B records what each became.
 *
 * WHY THIS IS PRODUCT CODE AND NOT A TEST HELPER
 * ==============================================
 * §25 does not ask for tests that happen to exist. It asks for a NAMED set of
 * canonical fixtures that the system is certified against, and it asks for that
 * certification to be REPLAYABLE. A fixture that lives inside one `.test.ts`
 * file is neither named nor replayable by anything else: another suite cannot
 * reach it, a script cannot run it, and nothing can say "certification ran and
 * this is what it found". So the fixtures, the invariants and the chaos
 * scenarios are modules, and `src/scripts/checkMemoryCertification.ts` runs
 * them. The tests then assert on the report rather than owning the world.
 *
 * REPLAYABLE MEANS NO CLOCK, NO RANDOMNESS, NO NETWORK
 * ===================================================
 * Every timestamp in every fixture is a literal. `now` is a field of the world,
 * never `new Date()`. There is no `Math.random`. The store below is an
 * in-memory object graph and the only client the certification path ever
 * touches. Two runs of the certification report are byte-identical, which is
 * what makes a diff between two commits meaningful — the whole point of §25.
 *
 * WHAT THE STORE IS, AND WHAT IT IS DELIBERATELY NOT
 * ==================================================
 * `certificationClient` implements the narrow `ClientLike` slice that
 * `services/memoryProjections/derivativeRegistry.ts` declares — select / eq /
 * in / neq / upsert / update, resolving (never throwing) with
 * `{ data, error }`, exactly as supabase-js does. That is enough to drive the
 * REAL `deriveProjection`, `rebuildProjection`, `projectionStaleness`,
 * `revokeDerivativesForMemory` and `searchMemories`.
 *
 * It is NOT a Postgres emulator and must not be read as one. It does not
 * enforce RLS, grants, constraints or triggers, so a certification pass here is
 * evidence about the TypeScript layer only. Anything that turns on the database
 * — an unapplied migration, a policy, a CHECK — is outside what this can
 * observe, and the invariant that depends on one reports `NO_SURFACE` rather
 * than a pass. See `invariants.ts`.
 */

import type {
  ClientLike,
  QueryLike,
} from "../memoryProjections/derivativeRegistry.js";
import type {
  MemoryItemRow,
  MemorySourceRow,
  MemoryTagRow,
} from "../memoryProjections/projectionRegistry.js";
import type { RawSignal } from "../memoryProjections/evidence.js";

/** Stable ids, so a fixture reads as a story rather than as four uuids. */
export const CERT_OWNER = "c0000000-0000-4000-8000-000000000001";
export const CERT_CREW_MATE = "c0000000-0000-4000-8000-000000000002";
export const CERT_STRANGER = "c0000000-0000-4000-8000-000000000003";
export const CERT_BLOCKED = "c0000000-0000-4000-8000-000000000004";
export const CERT_TRIP = "c0000000-0000-4000-8000-0000000000a1";

/** Every fixture is dated relative to this instant. Never `new Date()`. */
export const CERT_NOW_ISO = "2026-06-01T00:00:00.000Z";

/**
 * A Highlight row as `public.highlights` actually is today (migration
 * `0026_highlights.sql:8`), plus the owner-selected precision that migration
 * 2721 would store. The second is carried SEPARATELY from the row because it is
 * not a column on any deployed database, and merging the two would let a
 * fixture imply storage that does not exist.
 */
export interface CertHighlightRow {
  readonly id: string;
  readonly user_id: string;
  readonly trip_id: string | null;
  readonly caption: string | null;
  readonly location_name: string | null;
  readonly location_city: string | null;
  readonly location_country: string | null;
  readonly created_at: string;
  readonly expires_at: string | null;
  readonly deleted_at: string | null;
  readonly archived_at: string | null;
}

/**
 * One certification world: the canonical rows, the raw signals that would have
 * produced them, and the social facts a privacy invariant needs.
 */
export interface CertificationWorld {
  /** Reference instant. Every engine that needs a clock is handed this. */
  readonly now: string;
  readonly owner_id: string;
  /** Who is reading, when the fixture is about disclosure. */
  readonly viewer_id: string;
  readonly memories: readonly MemorySourceRow[];
  readonly items: readonly MemoryItemRow[];
  readonly tags: readonly MemoryTagRow[];
  /** §6 raw signals, un-normalized: the fixture's evidence, as it would arrive. */
  readonly signals: readonly RawSignal[];
  /** Pairs `[a, b]` meaning a and b cannot see each other. Symmetric by convention. */
  readonly blocks: readonly (readonly [string, string])[];
  readonly highlights: readonly CertHighlightRow[];
  /**
   * The owner's §10 location precision for a Highlight, keyed by highlight id.
   * Absent means "the owner has selected none", which is NOT a default rung —
   * `resolveLocationDisclosure` is explicit that choosing one here would be an
   * unmade owner decision.
   */
  readonly highlight_precision: Readonly<Record<string, string>>;
  /** Places policy or the owner marked sensitive (§11). */
  readonly sensitive_place_ids: readonly string[];
}

export type WorldOverrides = Partial<CertificationWorld>;

/** A canonical Memory row with every column present. Overrides win. */
export function certMemory(
  over: Partial<MemorySourceRow> & { id: string },
): MemorySourceRow {
  return {
    owner_id: CERT_OWNER,
    title: null,
    caption: null,
    visibility: "only_me",
    state: "published",
    trip_id: null,
    event_id: null,
    place_id: null,
    starts_at: null,
    ends_at: null,
    created_at: "2026-05-01T12:00:00.000Z",
    updated_at: "2026-05-01T12:00:00.000Z",
    location_city: null,
    location_country: null,
    location_lat: null,
    location_lng: null,
    canonical_location_id: null,
    allowed_user_ids: [],
    hidden_user_ids: [],
    ...over,
  };
}

export function certHighlight(
  over: Partial<CertHighlightRow> & { id: string },
): CertHighlightRow {
  return {
    user_id: CERT_OWNER,
    trip_id: null,
    caption: null,
    location_name: null,
    location_city: null,
    location_country: null,
    created_at: "2026-05-30T12:00:00.000Z",
    expires_at: "2026-06-02T12:00:00.000Z",
    deleted_at: null,
    archived_at: null,
    ...over,
  };
}

export function certWorld(over: WorldOverrides = {}): CertificationWorld {
  return {
    now: CERT_NOW_ISO,
    owner_id: CERT_OWNER,
    viewer_id: CERT_OWNER,
    memories: [],
    items: [],
    tags: [],
    signals: [],
    blocks: [],
    highlights: [],
    highlight_precision: {},
    sensitive_place_ids: [],
    ...over,
  };
}

/** Tables the certification client serves. Anything else is an unknown relation. */
export type CertTables = Record<string, Record<string, unknown>[]>;

/**
 * Turn a world into the mutable table set the real projection code reads.
 *
 * The registry table starts EMPTY: a certification run that wants a
 * registration must build one through `rebuildProjection`, so the registration
 * under test is the one production code writes rather than one a fixture
 * hand-rolled.
 */
export function tablesFor(world: CertificationWorld): CertTables {
  return {
    memories: world.memories.map((m) => ({ ...m })),
    memory_items: world.items.map((i) => ({ ...i })),
    memory_tags: world.tags.map((t) => ({ ...t })),
    memory_derivative_registry: [],
  };
}

export interface CertClientOptions {
  /**
   * Tables that answer with a database error instead of rows. This is how a
   * chaos scenario models an outage, and it is deliberately per-TABLE rather
   * than global: "the registry is down but canonical storage is fine" is the
   * case that separates a system that fails honestly from one that serves an
   * empty page.
   */
  readonly failTables?: ReadonlySet<string>;
  /** The error code failing tables report. 42P01 = relation does not exist. */
  readonly failCode?: string;
}

/**
 * A deterministic in-memory stand-in for the narrow supabase surface the
 * projection modules use.
 *
 * It resolves with `{ data, error }` and NEVER throws, because that is the one
 * supabase-js behaviour every caller in this repository has been written
 * against — a fake that threw would exercise a path production never takes.
 */
export function certificationClient(
  tables: CertTables,
  opts: CertClientOptions = {},
): ClientLike {
  const fail = opts.failTables ?? new Set<string>();
  const failCode = opts.failCode ?? "42P01";

  function chain(table: string): QueryLike {
    const predicates: Array<(r: Record<string, unknown>) => boolean> = [];
    let mode: "select" | "upsert" | "update" = "select";
    let payload: unknown = null;
    let conflictKeys: string[] = [];
    let selected = false;

    const run = async (): Promise<{ data: unknown; error: { code?: string; message?: string } | null }> => {
      if (fail.has(table)) {
        return { data: null, error: { code: failCode, message: `${table} is unavailable in this scenario` } };
      }
      const rows = (tables[table] ??= []);
      if (mode === "upsert") {
        const incoming = Array.isArray(payload) ? payload : [payload];
        const written: Record<string, unknown>[] = [];
        for (const raw of incoming) {
          const row = raw as Record<string, unknown>;
          const idx = conflictKeys.length > 0
            ? rows.findIndex((r) => conflictKeys.every((k) => r[k] === row[k]))
            : -1;
          if (idx >= 0) {
            rows[idx] = { ...rows[idx], ...row };
            written.push(rows[idx]!);
          } else {
            const stored = { id: `${table}-${rows.length + 1}`, ...row };
            rows.push(stored);
            written.push(stored);
          }
        }
        return { data: selected ? written : null, error: null };
      }
      if (mode === "update") {
        const hit = rows.filter((r) => predicates.every((p) => p(r)));
        for (const r of hit) Object.assign(r, payload as Record<string, unknown>);
        return { data: selected ? hit : null, error: null };
      }
      return { data: rows.filter((r) => predicates.every((p) => p(r))), error: null };
    };

    const obj: QueryLike = {
      select() { selected = true; return obj; },
      eq(column, value) { predicates.push((r) => r[column] === value); return obj; },
      neq(column, value) { predicates.push((r) => r[column] !== value); return obj; },
      in(column, values) {
        const set = new Set(values as readonly unknown[]);
        predicates.push((r) => set.has(r[column]));
        return obj;
      },
      upsert(values, options) {
        mode = "upsert";
        payload = values;
        conflictKeys = (options?.onConflict ?? "").split(",").map((s) => s.trim()).filter(Boolean);
        return obj;
      },
      update(values) { mode = "update"; payload = values; return obj; },
      then(onfulfilled, onrejected) { return run().then(onfulfilled as never, onrejected as never); },
    };
    return obj;
  }

  return { from: (t: string) => chain(t) };
}

/** Is `a` blocked from `b` in either direction? Blocks are symmetric here. */
export function isBlockedPair(world: CertificationWorld, a: string, b: string): boolean {
  return world.blocks.some(([x, y]) => (x === a && y === b) || (x === b && y === a));
}
