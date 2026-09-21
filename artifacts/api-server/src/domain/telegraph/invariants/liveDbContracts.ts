/**
 * Telegraph §27.3 — the six live-DB contract checks, mapped to the standing
 * lanes that actually enforce them.
 *
 * These six are the strongest part of this census's picture, and the reason is
 * worth stating: they were built by the migration programme for the whole
 * repository, not for Telegraph, and Telegraph inherits them. That is an
 * inheritance worth recording explicitly, because an inherited guarantee can be
 * lost by a scope change in someone else's file, and nothing would have said so.
 *
 * What `src/scripts/checkTelegraphCertification.ts` verifies here:
 *   - every `checkScript` names a script that EXISTS in package.json, so a
 *     renamed or deleted lane breaks this contract rather than quietly
 *     un-enforcing it;
 *   - every `enforcedBy` path resolves on disk;
 *   - each id is named by the certification test.
 *
 * Two entries are `divergent`, and neither can be closed by a guard.
 */

import type { LiveDbContract } from "../contracts/certification.js";

export const TELEGRAPH_LIVE_DB_CONTRACTS: readonly LiveDbContract[] = [
  {
    id: "LDB-01",
    censusRow: "T340",
    requirement: "Every selected/written column exists in CI and production schema",
    status: "enforced",
    checkScript: "check:missing-live-columns",
    enforcedBy: [
      "src/scripts/checkMissingLiveColumns.ts",
      "src/scripts/checkWritePathColumns.ts",
      "src/scripts/auditMigrationsVsLive.ts",
    ],
    note:
      "Three lanes, two directions: read-path columns that the live schema lacks, " +
      "write-path columns that the live schema lacks, and migrations whose objects " +
      "the live schema lacks. All three require live credentials and FAIL rather " +
      "than skip without them, which is the property that matters — an unrunnable " +
      "schema reconciliation must not read as a clean one.",
  },
  {
    id: "LDB-02",
    censusRow: "T341",
    requirement: "Every enum literal exists in the live database",
    status: "enforced",
    checkScript: "check:enum-literals",
    enforcedBy: ["src/scripts/checkEnumLiterals.ts"],
    note:
      "Matters more for Telegraph than the row count suggests: thread_type, " +
      "msg_type, subtype and the message-request status vocabulary are all string " +
      "literals written by routes, and a literal the database's CHECK constraint " +
      "does not accept fails at insert time on a user's send.",
  },
  {
    id: "LDB-03",
    censusRow: "T342",
    requirement: "Every RLS role has intended positive and negative access",
    status: "enforced",
    checkScript: "check:authorization-contract",
    enforcedBy: [
      "src/scripts/rlsDispositions.ts",
      "src/test/rlsPolicyShapeLive.test.ts",
      "src/scripts/checkAuthorizationContract.ts",
    ],
    note:
      "A per-table ledger of expected policy class and policy count, a live shape " +
      "test, and a CI lane that goes red when a migration restores broad " +
      "anon/authenticated mutation privilege. The Telegraph tables are in the " +
      "ledger — including message_reports and thread_reports, which have no writer " +
      "and no reader in application code and are dispositioned anyway, which is " +
      "the right treatment for an orphan: still governed.",
  },
  {
    id: "LDB-04",
    censusRow: "T343",
    requirement: "Migrations additive/idempotent where designed, and include postconditions",
    status: "enforced",
    checkScript: "check:migration-ledger",
    enforcedBy: [
      "src/scripts/certifyMigrations.ts",
      "src/scripts/checkMigrationLedger.ts",
      "src/scripts/checkMigrationPrefixes.ts",
      "src/migrations/2400_telegraph_history_bound.sql",
    ],
    note:
      "The convention is enforced by three scripts and visible in the Telegraph " +
      "migration that exists: 2400 opens with a precondition block that refuses to " +
      "run unless the objects it depends on are present, and closes by re-reading " +
      "the catalog to assert what it created. That is the shape the lane checks " +
      "for, and it is the reason a Telegraph migration cannot half-apply silently.",
  },
  {
    id: "LDB-05",
    censusRow: "T344",
    requirement:
      "No silent catch converts a schema/permission failure into a plausible " +
      "empty inbox/context",
    status: "divergent",
    checkScript: "check:silent-supabase-writes",
    enforcedBy: [
      "src/scripts/checkUncheckedSupabaseReads.ts",
      "src/scripts/checkSilentSupabaseWrites.ts",
      "src/test/silentSchemaErrorCatches.test.ts",
      "src/routes/messaging.ts",
    ],
    note:
      "The ratchets are real and unusually good — the read checker resolves " +
      "consumers structurally rather than textually and treats an exclusion-table " +
      "read whose error is dropped as fail-open by construction. But route " +
      "HANDLERS are deliberately out of its gate-function tier, and that is " +
      "precisely where the messaging surface still drops errors: the per-viewer " +
      "translation read, the trip and booking context reads and the circle read " +
      "in the inbox projection all bind `data` only, so an unreadable table " +
      "renders as an untranslated message or a thread with no trip context — " +
      "plausible, and wrong. The two reads that most alarmed the census (the " +
      "membership checks) resolve to a 403, which is a refusal and not an empty " +
      "inbox; the send path's block-guard roster read has since been fixed to " +
      "refuse outright. So this is smaller than it was and still not closed.",
  },
  {
    id: "LDB-06",
    censusRow: "T345",
    requirement: "Direct-write ratchets can only shrink",
    status: "enforced",
    checkScript: "check:authorization-contract",
    enforcedBy: [
      "src/scripts/checkAuthorizationContract.ts",
      "src/scripts/frozenLegacyFiles.ts",
      "src/scripts/frozenMigrationRoots.ts",
    ],
    note:
      "Shrink-only for client mutation privilege, and hash-pinned for the legacy " +
      "migration set — including the two orphan report-table migrations, which " +
      "cannot be edited into life or out of it without the pin failing.",
  },
];

export const TELEGRAPH_LIVE_DB_IDS: readonly string[] =
  TELEGRAPH_LIVE_DB_CONTRACTS.map((c) => c.id);
