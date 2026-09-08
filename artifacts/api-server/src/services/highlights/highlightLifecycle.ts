/**
 * highlightLifecycle — the §12 / §3.5 / §5 Highlight vocabulary, and an HONEST
 * answer about how much of it this database can actually hold.
 *
 * Highlights/Memories Development Architecture Spec v1:
 *   §3.5  Highlight { … highlight_type, lifetime_class, lifecycle_state,
 *         starts_at, expires_at, ranking_score, reason_codes,
 *         audience_policy_id, presentation_json, renderer_version }
 *   §4    HighlightLifetime = LIVE | DAY | TRIP | SEASONAL | PERMANENT
 *   §5    Highlight lifecycle
 *             DRAFT -> ACTIVE -> EXPIRED
 *                       |          ^
 *                       v          |
 *                     PINNED ---- HIDDEN
 *   §12   The five classes and their default behaviour.
 *
 * ── WHY THIS FILE REFUSES TO GUESS ──────────────────────────────────────────
 * The census (docs/architecture/census-highlights-memories.md, §12) records
 * H94-H98 — the five lifetime classes — as NOT-BUILT, with the note that the
 * only knob that exists is a free `expiresInHours`. It would be easy, and
 * wrong, to "implement" the classes by bucketing that number: 3h→LIVE, 24h→DAY,
 * anything longer→TRIP. Nothing in the spec assigns hour boundaries to the
 * classes, so those boundaries would be invented product policy wearing the
 * spec's vocabulary — exactly the failure mode the census's "0 of 17 correct
 * requirements are spec-attributable" line is about.
 *
 * So: a class is STORED or it is UNKNOWN. There is no third, inferred kind.
 * `describeHighlightLifetime` reports `provenance: "unavailable"` and names the
 * migration that would make the column exist. A caller that wants to render a
 * class badge gets nothing to render, which is the truth.
 *
 * ── WHAT IS MEASURED, NOT ASSUMED ───────────────────────────────────────────
 * Against the committed production schema snapshot
 * `src/lib/capability/snapshots/20260908-production-schema.json`:
 *
 *   public.highlights columns = id, owner_id, media_url, media_type,
 *   video_duration_seconds, caption, location_name, location_city,
 *   location_country, visibility, expires_at, created_at, deleted_at,
 *   archived_at, filter_id, filter_intensity, updated_at
 *
 * Of the eleven §3.5 fields, this table holds THREE (id, expires_at as the
 * §3.5 expires_at, and owner_id, which §3.5 also names). It holds no
 * highlight_type, no lifetime_class, no lifecycle_state, no source_memory_ids,
 * no ranking_score, no reason_codes, no audience_policy_id, no
 * presentation_json and no renderer_version.
 *
 * `expires_at` is NOT NULL (baseline/20260819_baseline_structure.sql:6774 and
 * migrations/0026_highlights.sql:19). PERMANENT is therefore NOT REPRESENTABLE
 * on production today — not "unimplemented", structurally impossible, because a
 * PERMANENT Highlight is one with no expiry. Making it nullable is exactly what
 * unmerged PR #461 / migration 2313 does, and that migration must not be
 * adopted here (it reintroduces a `trip_members` self-join that applied
 * migration 2530 removed). `representableLifetimeClasses` states this rather
 * than leaving a reader to discover it.
 *
 * PURE. No I/O, no clock except the one you pass.
 */

// ── §4 HighlightLifetime ─────────────────────────────────────────────────────

export const HIGHLIGHT_LIFETIME_CLASSES = ["LIVE", "DAY", "TRIP", "SEASONAL", "PERMANENT"] as const;
export type HighlightLifetimeClass = (typeof HIGHLIGHT_LIFETIME_CLASSES)[number];

export function isHighlightLifetimeClass(v: unknown): v is HighlightLifetimeClass {
  return typeof v === "string" && (HIGHLIGHT_LIFETIME_CLASSES as readonly string[]).includes(v);
}

/**
 * §12's table, verbatim in structure: class → the default behaviour the spec
 * states for it. Carried as data so a renderer or a policy check reads the
 * spec's words rather than a paraphrase someone typed into a switch.
 */
export const HIGHLIGHT_CLASS_DEFAULTS: Readonly<
  Record<HighlightLifetimeClass, { readonly example: string; readonly defaultBehavior: string }>
> = Object.freeze({
  LIVE: {
    example: "Tonight with the crew",
    defaultBehavior: "Short-lived; high freshness; no stale location.",
  },
  DAY: {
    example: "Day 4 in Da Nang",
    defaultBehavior: "Expires after recent context unless pinned.",
  },
  TRIP: {
    example: "Japan 2026",
    defaultBehavior: "Lives through Trip and may remain as curated recap.",
  },
  SEASONAL: {
    example: "Summer in Asia",
    defaultBehavior: "Dynamic collection over multiple Trips/Memories.",
  },
  PERMANENT: {
    example: "First Portava Trip",
    defaultBehavior: "Explicit or milestone-driven durable Highlight.",
  },
});

/**
 * Which classes a database with these capabilities can actually hold.
 *
 * `permanentRequiresNullableExpiry` is the whole content of the answer: with a
 * NOT NULL `expires_at`, PERMANENT cannot be stored no matter what the
 * `lifetime_class` column says, so a row claiming PERMANENT while carrying an
 * expiry is self-contradictory and is reported as such.
 */
export function representableLifetimeClasses(cap: {
  lifetimeClassColumn: boolean;
  expiresAtNullable: boolean;
}): {
  readonly representable: readonly HighlightLifetimeClass[];
  readonly unrepresentable: ReadonlyArray<{ cls: HighlightLifetimeClass; why: string }>;
} {
  if (!cap.lifetimeClassColumn) {
    return {
      representable: [],
      unrepresentable: HIGHLIGHT_LIFETIME_CLASSES.map((cls) => ({
        cls,
        why: "highlights.lifetime_class does not exist (migration 2723 not applied)",
      })),
    };
  }
  if (!cap.expiresAtNullable) {
    return {
      representable: HIGHLIGHT_LIFETIME_CLASSES.filter((c) => c !== "PERMANENT"),
      unrepresentable: [
        {
          cls: "PERMANENT",
          why: "highlights.expires_at is NOT NULL; a PERMANENT Highlight has no expiry",
        },
      ],
    };
  }
  return { representable: HIGHLIGHT_LIFETIME_CLASSES, unrepresentable: [] };
}

export type LifetimeDescription =
  | { provenance: "stored"; cls: HighlightLifetimeClass }
  | { provenance: "unavailable"; cls: null; reason: string }
  | { provenance: "invalid"; cls: null; reason: string };

/**
 * The lifetime class of a row. STORED or nothing — never inferred from
 * `expires_at - created_at`; see the header.
 */
export function describeHighlightLifetime(row: {
  lifetime_class?: unknown;
  expires_at?: unknown;
}): LifetimeDescription {
  if (!("lifetime_class" in row) || row.lifetime_class === undefined) {
    return {
      provenance: "unavailable",
      cls: null,
      reason:
        "highlights.lifetime_class was not projected or does not exist; §12 class is unknown, not inferred from expiry",
    };
  }
  if (row.lifetime_class === null) {
    return {
      provenance: "unavailable",
      cls: null,
      reason: "highlights.lifetime_class is NULL for this row; no class has been assigned",
    };
  }
  if (!isHighlightLifetimeClass(row.lifetime_class)) {
    return {
      provenance: "invalid",
      cls: null,
      reason: `highlights.lifetime_class holds ${JSON.stringify(row.lifetime_class)}, which is not a §4 HighlightLifetime value`,
    };
  }
  if (row.lifetime_class === "PERMANENT" && row.expires_at != null) {
    return {
      provenance: "invalid",
      cls: null,
      reason: "row claims PERMANENT while carrying an expires_at; a PERMANENT Highlight has no expiry",
    };
  }
  return { provenance: "stored", cls: row.lifetime_class };
}

// ── §5 Highlight lifecycle ───────────────────────────────────────────────────

export const HIGHLIGHT_LIFECYCLE_STATES = ["DRAFT", "ACTIVE", "EXPIRED", "PINNED", "HIDDEN"] as const;
export type HighlightLifecycleState = (typeof HIGHLIGHT_LIFECYCLE_STATES)[number];

/**
 * §5's diagram as an adjacency list. Read it against the ASCII in the spec:
 *
 *   DRAFT -> ACTIVE -> EXPIRED
 *             |          ^
 *             v          |
 *           PINNED ---- HIDDEN
 *
 * DRAFT→ACTIVE, ACTIVE→EXPIRED, ACTIVE→PINNED, PINNED→HIDDEN, HIDDEN→EXPIRED.
 * Nothing leaves EXPIRED: it is the only terminal state in the Highlight
 * machine, and note that DELETED is NOT in it at all — deletion is §21's
 * separate lifecycle (ACTIVE → DELETION_REQUESTED → PUBLIC_REVOKED →
 * DERIVATIVES_PURGED → RAW_EVIDENCE_PURGED → DELETED) and the two must not be
 * merged. See highlightRevocation.ts.
 */
const LIFECYCLE_TRANSITIONS: Readonly<Record<HighlightLifecycleState, readonly HighlightLifecycleState[]>> =
  Object.freeze({
    DRAFT: ["ACTIVE"],
    ACTIVE: ["EXPIRED", "PINNED"],
    PINNED: ["HIDDEN"],
    HIDDEN: ["EXPIRED"],
    EXPIRED: [],
  });

export function isHighlightLifecycleState(v: unknown): v is HighlightLifecycleState {
  return typeof v === "string" && (HIGHLIGHT_LIFECYCLE_STATES as readonly string[]).includes(v);
}

export function allowedLifecycleTransitions(from: HighlightLifecycleState): readonly HighlightLifecycleState[] {
  return LIFECYCLE_TRANSITIONS[from];
}

/** §5. A transition not on the diagram is not a transition. */
export function isValidLifecycleTransition(from: unknown, to: unknown): boolean {
  if (!isHighlightLifecycleState(from) || !isHighlightLifecycleState(to)) return false;
  return LIFECYCLE_TRANSITIONS[from].includes(to);
}

export type LifecycleDescription =
  | { provenance: "stored"; state: HighlightLifecycleState }
  | { provenance: "derived"; state: HighlightLifecycleState; from: string }
  | { provenance: "unavailable"; state: null; reason: string }
  | { provenance: "out_of_machine"; state: null; reason: string };

/**
 * The lifecycle state of a row.
 *
 * ── THE ONE INFERENCE THIS FILE ALLOWS, AND WHY IT IS NOT A GUESS ───────────
 * Unlike the lifetime class, two of the five states have an exact, non-arbitrary
 * witness in the columns that already exist:
 *
 *   EXPIRED — `expires_at <= now`. §5's EXPIRED and §3.5's expires_at are the
 *             same fact stated twice; there is no boundary to invent.
 *   ACTIVE  — not expired, not archived, not deleted. §5's ACTIVE is the state
 *             a Highlight is in while it is being browsed, which is exactly
 *             what the routes' active predicate already tests.
 *
 * DRAFT and PINNED have NO witness — nothing in the schema records "not yet
 * published" or "the owner pinned this" — so they are never derived.
 *
 * HIDDEN is the interesting one, and it is why this function exists.
 * `deleted_at` is NOT hidden. §5 puts HIDDEN inside the reversible cycle
 * (PINNED → HIDDEN → EXPIRED) and §21 makes Delete terminal and separate from
 * Archive. `deleted_at` is a SOFT DELETE: DELETE /highlights/:id sets it, no
 * route clears it, and lib/deletionDispositions.ts lists `highlights` under
 * ERASED_BY_CASCADE. Reporting a soft-deleted row as HIDDEN would say a
 * terminal act is reversible. So a deleted row is `out_of_machine`, and only
 * `archived_at` — the reversible column, which the archive endpoints set and
 * clear — derives HIDDEN.
 */
export function describeHighlightLifecycle(
  row: {
    lifecycle_state?: unknown;
    expires_at?: unknown;
    deleted_at?: unknown;
    archived_at?: unknown;
  },
  now: Date = new Date(),
): LifecycleDescription {
  if ("lifecycle_state" in row && row.lifecycle_state != null) {
    if (isHighlightLifecycleState(row.lifecycle_state)) {
      return { provenance: "stored", state: row.lifecycle_state };
    }
    return {
      provenance: "unavailable",
      state: null,
      reason: `highlights.lifecycle_state holds ${JSON.stringify(row.lifecycle_state)}, which is not a §5 state`,
    };
  }

  if (row.deleted_at != null) {
    return {
      provenance: "out_of_machine",
      state: null,
      reason:
        "row is soft-deleted (deleted_at set). §21 deletion is a separate lifecycle from §5's; a deleted Highlight is not HIDDEN",
    };
  }

  if (row.archived_at != null) {
    return { provenance: "derived", state: "HIDDEN", from: "archived_at" };
  }

  if (row.expires_at == null) {
    return {
      provenance: "unavailable",
      state: null,
      reason: "no lifecycle_state column and no expires_at to derive from",
    };
  }
  const exp = new Date(String(row.expires_at));
  if (Number.isNaN(exp.getTime())) {
    return {
      provenance: "unavailable",
      state: null,
      reason: `expires_at ${JSON.stringify(row.expires_at)} is not a parseable timestamp`,
    };
  }
  return exp > now
    ? { provenance: "derived", state: "ACTIVE", from: "expires_at > now" }
    : { provenance: "derived", state: "EXPIRED", from: "expires_at <= now" };
}
