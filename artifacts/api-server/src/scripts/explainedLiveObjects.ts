/**
 * The EXPLAINED ledger — the in-source, one-file, diff-visible list of LIVE
 * database objects that the canonical MODEL does not otherwise explain, plus
 * the pure validators that keep the ledger itself honest.
 *
 * WHY A LEDGER AT ALL. The inverse auditor (src/scripts/auditLiveVsCanonical.ts,
 * `audit:live-unexplained`) builds a MODEL from the committed baseline dump plus
 * the canonical migrations whose 4-digit prefix sorts >= "2100", and flags every
 * live object the model cannot account for. Some live objects are known,
 * accepted, and deliberately not (yet) represented by a migration — the
 * canonical example is a Postgres EXTENSION, which no committed `.sql` in this
 * repo installs (the 20260819 baseline contains ZERO `CREATE EXTENSION`,
 * verified) but which the live catalog carries because the Supabase project
 * bootstrap installed it. Rather than widen the auditor with per-object special
 * cases, those objects are enumerated HERE, once, with provenance and a
 * disposition a reviewer can read. An object whose lower-cased key is in this
 * ledger is treated as explained; an object that is neither modelled nor
 * ledgered is UNEXPLAINED_LIVE (exit 1).
 *
 * WHY THIS FILE HOLDS NO I/O AND NAMES NO CREDENTIAL. It is data plus pure
 * validators only. It reads no environment, opens no client, and touches no
 * filesystem, so scripts/check-guard-coverage.mjs does not (and must not) force
 * a Supabase guard onto it: it is unreachable to the database by construction.
 * Keep it that way — the moment it references a credential env var or opens a
 * client it becomes a guarded entry point.
 *
 * SEED SCOPE AGAINST THE 20260819 BASELINE. The committed baseline is a
 * structure-only dump of PRODUCTION captured 2026-08-19, and it already carries
 * the "spine" — the four formerly-unexplained live tables (`circles`,
 * `compass_analytics`, `user_trust_scores`, and the VIEW
 * `public_profile_verification`), `profiles.role` and the other formerly
 * undeclared `profiles` columns, `post_impressions.created_at`, `post_saves.id`,
 * and the `storage.objects` policies (see docs/RECONCILIATION-PACKET.md:462).
 * ALL of those are therefore modelled from the baseline and need NO ledger
 * entry — seeding them here would falsely imply ledger-only coverage for an
 * object the model already explains, and would be redundant. The one class the
 * baseline genuinely cannot supply is EXTENSIONS (the dump omits them), so that
 * is what this seed carries.
 *
 * OWNER ACTION REQUIRED BEFORE THE FIRST GREEN RUN. The extension seed below is
 * BEST-EFFORT: this file was authored without live database access, so the
 * exact `pg_extension` census could not be read. `pgcrypto` is confirmed
 * required (docs/RECONCILIATION-PACKET.md:163 — `gen_random_bytes()` at
 * 0080_events_extension.sql:341 needs it, no canonical file installs it) and the
 * baseline confirms it in use (`extensions.gen_random_bytes(...)`). The
 * remaining entries are the extensions Supabase enables by default on essentially
 * every project. Before the first prod read-only run is expected to pass, the
 * owner MUST reconcile this list against `select extname from pg_extension` on
 * the live project in Replit: any live extension NOT seeded here surfaces as
 * UNEXPLAINED_LIVE (exit 1) — a deliberate forcing function — and any seeded
 * extension NOT present live surfaces as STALE_LEDGER_ENTRY (exit 1). Add or
 * remove `extension:<name>` rows until the two agree.
 */

/** The ten live inventories plus the ledger-only closures a key may name. */
export type LedgerKind =
  | "relation"
  | "column"
  | "function"
  | "policy"
  | "trigger"
  | "grant"
  | "columngrant"
  | "enum"
  | "enumvalue"
  | "index"
  | "constraint"
  | "extension";

/**
 * Why a modelled-elsewhere-but-accepted-here object is allowed to exist live.
 *
 *   MERGED_LIVE_SHAPE            live shape adopted into the baseline verbatim.
 *   SPINE_UNDECLARED            a spine object no migration declares.
 *   LEGACY_PROVENANCE           installed by project bootstrap / pre-repo history.
 *   CORRECTIVE_MIGRATION_PENDING explained by ledger only, a corrective is forecast.
 *   HARDENED_INVARIANT          an invariant a deep_verifier proves in CI (verifier MANDATORY).
 *   REVIEWED_ACCEPTED           reviewed and accepted as-is.
 */
export type LedgerDisposition =
  | "MERGED_LIVE_SHAPE"
  | "SPINE_UNDECLARED"
  | "LEGACY_PROVENANCE"
  | "CORRECTIVE_MIGRATION_PENDING"
  | "HARDENED_INVARIANT"
  | "REVIEWED_ACCEPTED";

export interface ExplainedEntry {
  /**
   * Fully-qualified key, lower-cased, byte-identical to the live-sweep key the
   * auditor forms, e.g. 'relation:circles', 'column:profiles.role',
   * 'extension:pgcrypto', 'policy:public.posts.posts_select'.
   */
  key: string;
  kind: LedgerKind;
  /**
   * `file:line` (or a census/bootstrap ref that still ends `:<token>`) of
   * whatever ACTUALLY created the object. Frozen roots and the Q12 census /
   * Supabase bootstrap are allowed here and only here.
   */
  provenance: string;
  disposition: LedgerDisposition;
  /** Non-empty prose. */
  reason: string;
  /** ISO 8601 date this entry was recorded. */
  reviewed_on: string;
  /** Form '2107_x.sql'; the named file must sort >= '2100'. */
  corrective_migration?: string;
  /** npm script key; MANDATORY iff disposition === 'HARDENED_INVARIANT'. */
  deep_verifier?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// THE SEED. Extensions only, for the reasons in the header. Every provenance
// ends in `:<token>` so validateLedgerShape accepts it. reviewed_on is the
// authoring date; re-date a row when its reason materially changes.
// ─────────────────────────────────────────────────────────────────────────────
export const EXPLAINED_LIVE_OBJECTS: ReadonlyArray<ExplainedEntry> = [
  {
    // CONFIRMED. gen_random_bytes() at 0080_events_extension.sql:341 needs it,
    // no canonical file installs it, and the baseline shows it in use via
    // extensions.gen_random_bytes(...). This one is not a guess.
    key: "extension:pgcrypto",
    kind: "extension",
    provenance: "docs/RECONCILIATION-PACKET.md:163",
    disposition: "LEGACY_PROVENANCE",
    reason:
      "installed by project bootstrap; no canonical file installs it (packet §4.1 Q12). Required by gen_random_bytes() at 0080_events_extension.sql:341; baseline confirms use via extensions.gen_random_bytes().",
    reviewed_on: "2026-08-19",
  },
  // ── BEST-EFFORT below this line — reconcile against `select extname from
  //    pg_extension` on the live project before expecting a green run. ────────
  {
    key: "extension:plpgsql",
    kind: "extension",
    provenance: "docs/RECONCILIATION-PACKET.md:163",
    disposition: "LEGACY_PROVENANCE",
    reason:
      "procedural language enabled by default on every Postgres/Supabase project; no canonical file installs it (packet §4.1 Q12). TODO: confirm against live pg_extension in Replit.",
    reviewed_on: "2026-08-19",
  },
  {
    key: "extension:pg_graphql",
    kind: "extension",
    provenance: "docs/RECONCILIATION-PACKET.md:163",
    disposition: "LEGACY_PROVENANCE",
    reason:
      "Supabase default-enabled extension; no canonical file installs it (packet §4.1 Q12). TODO: confirm against live pg_extension in Replit.",
    reviewed_on: "2026-08-19",
  },
  {
    key: "extension:pg_stat_statements",
    kind: "extension",
    provenance: "docs/RECONCILIATION-PACKET.md:163",
    disposition: "LEGACY_PROVENANCE",
    reason:
      "Supabase default-enabled query-statistics extension; no canonical file installs it (packet §4.1 Q12). TODO: confirm against live pg_extension in Replit.",
    reviewed_on: "2026-08-19",
  },
  {
    key: "extension:pgjwt",
    kind: "extension",
    provenance: "docs/RECONCILIATION-PACKET.md:163",
    disposition: "LEGACY_PROVENANCE",
    reason:
      "Supabase default-enabled JWT helper extension; no canonical file installs it (packet §4.1 Q12). TODO: confirm against live pg_extension in Replit — some newer projects omit it.",
    reviewed_on: "2026-08-19",
  },
  {
    key: "extension:uuid-ossp",
    kind: "extension",
    provenance: "docs/RECONCILIATION-PACKET.md:163",
    disposition: "LEGACY_PROVENANCE",
    reason:
      "Supabase default-enabled UUID generator extension; no canonical file installs it (packet §4.1 Q12). TODO: confirm against live pg_extension in Replit.",
    reviewed_on: "2026-08-19",
  },
  {
    key: "extension:supabase_vault",
    kind: "extension",
    provenance: "docs/RECONCILIATION-PACKET.md:163",
    disposition: "LEGACY_PROVENANCE",
    reason:
      "Supabase-managed secrets vault extension enabled by the project bootstrap; no canonical file installs it (packet §4.1 Q12). TODO: confirm against live pg_extension in Replit.",
    reviewed_on: "2026-08-19",
  },
];

export interface LedgerShapeProblem {
  entryIndex: number;
  key: string;
  code: string;
  detail: string;
}

/**
 * PURE shape validation — no filesystem, no live catalog. Flags structural
 * defects in the ledger itself: vacuity, duplicate keys, empty required fields,
 * a provenance that does not resolve to a `file:line`-or-census reference, a
 * HARDENED_INVARIANT entry with no deep_verifier, and a corrective_migration
 * that does not name a file sorting >= '2100'. It deliberately does NOT check
 * reachability or file existence — those need the live census and the
 * filesystem, and are the auditor's job. Every problem returned here is an
 * exit-1 FINDING (mirroring check-guard-coverage.mjs, where vacuity is a found
 * problem), never a cannot-establish.
 */
export function validateLedgerShape(
  entries: ReadonlyArray<ExplainedEntry>,
): LedgerShapeProblem[] {
  const problems: LedgerShapeProblem[] = [];
  const push = (entryIndex: number, key: string, code: string, detail: string) =>
    problems.push({ entryIndex, key, code, detail });

  // Vacuity. An empty ledger cannot be told apart from a ledger someone
  // deleted; it is a problem, not a pass. (Same stance as the guard-coverage
  // vacuity gates.)
  if (entries.length === 0) {
    push(
      -1,
      "",
      "LEDGER_VACUOUS",
      "EXPLAINED_LIVE_OBJECTS is empty. An empty ledger explains nothing and " +
        "cannot be distinguished from an accidentally-cleared one.",
    );
    return problems;
  }

  const seen = new Set<string>();
  const provenanceRe = /.+:\S+$/;
  const correctiveRe = /^(\d{4})_\S*\.sql$/;

  entries.forEach((e, i) => {
    const key = e.key ?? "";

    if (!key.trim()) {
      push(i, key, "EMPTY_KEY", "Entry has an empty key.");
    } else if (seen.has(key)) {
      push(
        i,
        key,
        "DUPLICATE_KEY",
        `Key '${key}' appears more than once. A duplicated entry hides which reason is in force.`,
      );
    } else {
      seen.add(key);
    }

    if (!e.reason || !e.reason.trim()) {
      push(i, key, "EMPTY_REASON", "Entry has an empty reason.");
    }
    if (!e.reviewed_on || !e.reviewed_on.trim()) {
      push(i, key, "EMPTY_REVIEWED_ON", "Entry has an empty reviewed_on.");
    }
    if (!e.provenance || !e.provenance.trim()) {
      push(i, key, "EMPTY_PROVENANCE", "Entry has an empty provenance.");
    } else if (!provenanceRe.test(e.provenance.trim())) {
      push(
        i,
        key,
        "PROVENANCE_UNRESOLVED",
        `Provenance '${e.provenance}' does not resolve to a file:line or census reference (must end ':<token>').`,
      );
    }

    if (e.disposition === "HARDENED_INVARIANT" && !e.deep_verifier?.trim()) {
      push(
        i,
        key,
        "HARDENED_WITHOUT_VERIFIER",
        "A HARDENED_INVARIANT entry must name a deep_verifier (an npm script that proves the invariant in CI).",
      );
    }

    if (e.corrective_migration !== undefined) {
      const cm = e.corrective_migration.trim();
      const m = correctiveRe.exec(cm);
      if (!m) {
        push(
          i,
          key,
          "CORRECTIVE_MALFORMED",
          `corrective_migration '${cm}' is not of the form '2107_x.sql'.`,
        );
      } else if (m[1] < "2100") {
        push(
          i,
          key,
          "CORRECTIVE_BELOW_BAND",
          `corrective_migration '${cm}' names a file whose 4-digit prefix ${m[1]} sorts below '2100' (the reserved corrective band).`,
        );
      }
    }
  });

  return problems;
}

/** Lower-cased key set, mirroring the auditor's live-sweep lc(). */
export function ledgerKeySet(entries: ReadonlyArray<ExplainedEntry>): Set<string> {
  return new Set(entries.map((e) => e.key.toLowerCase()));
}

/** deep_verifier names declared on HARDENED_INVARIANT entries, to assert wired. */
export function hardenedVerifiers(entries: ReadonlyArray<ExplainedEntry>): string[] {
  return entries
    .filter((e) => e.disposition === "HARDENED_INVARIANT" && e.deep_verifier)
    .map((e) => e.deep_verifier as string);
}
