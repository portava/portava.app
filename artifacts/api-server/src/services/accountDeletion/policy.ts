/**
 * DeletionPolicy — the CONFIGURATION that answers owner decision D6, and the
 * one thing in this directory allowed to decide a table's fate.
 *
 * ── WHY THIS IS EMPTY ───────────────────────────────────────────────────────
 * D6 is not answered. `UNSET_POLICY` therefore names no table, and every
 * planner and executor path treats an unnamed table as UNRESOLVED rather than
 * as "nothing to do". That is the entire point of the architecture around it:
 * when the owner rules, the change is a policy file, not another rewrite of the
 * deletion engine.
 *
 * ── WHAT IS ALREADY RESOLVED, AND WHY THAT IS NOT A DECISION ────────────────
 * Some tables have a fate TODAY, in code that already ships: the ones
 * lib/deletionDispositions.ts lists as ERASED_BY_CASCADE (AccountDeletionService
 * deletes them), ANONYMISED_FK_NULLED (it NULLs the identifier),
 * RETAINED_WITH_REASON (a decided retention with a written reason) and the two
 * DELETION_FLOW tables (the deletion's own receipt). Reporting those as
 * resolved describes behaviour that exists; it does not choose anything. Every
 * other user-keyed table resolves to UNRESOLVED — 225 of them by the manifest's
 * own count, plus the ones the manifest cannot see at all.
 *
 * A CANDIDATE CLASS IS NEVER A RESOLUTION. `graph.candidate` is an engineering
 * observation about the evidence; nothing in this file reads it.
 */
import type { DeletionGraphNode } from "../../lib/deletion/types.js";
import { RETAINED_WITH_REASON } from "../../lib/deletionDispositions.js";

export type PolicyFate = "DELETE" | "ANONYMIZE" | "RETAIN";

export interface PolicyEntry {
  table: string;
  fate: PolicyFate;
  /**
   * WHO decided, in a form a later reader can check — a ruling date, a packet
   * reference, a ticket. An entry without one is rejected by
   * `validatePolicy`: an unattributed fate is indistinguishable from a guess.
   */
  authority: string;
  /** Required when the fate crosses a retention signal — see legalRetentionBoundary.ts. */
  overridesRetentionSignal?: boolean;
  reason?: string;
}

export interface DeletionPolicy {
  version: string;
  entries: readonly PolicyEntry[];
}

/** The policy as it stands: D6 unanswered, nothing chosen here. */
export const UNSET_POLICY: DeletionPolicy = { version: "unset-d6-open", entries: [] };

export type Resolution =
  | { resolved: true; fate: PolicyFate; source: "policy" | "manifest"; authority: string; entry?: PolicyEntry }
  | { resolved: false; reason: string };

/**
 * The fates that already exist in shipped code, cited to the code that performs
 * them. Not decisions taken here — descriptions of what runs today.
 */
const FLOW_TABLE_FATES: Readonly<Record<string, { fate: PolicyFate; authority: string }>> = {
  // mark_request_completed sets user_id: null on the receipt row.
  user_deletion_requests: {
    fate: "ANONYMIZE",
    authority: "AccountDeletionService step mark_request_completed (owner ruling 3, 2026-08-23): the completed receipt stops naming a person",
  },
  // mark_account_state upserts a row keyed by user_id and keeps it.
  user_account_states: {
    fate: "RETAIN",
    authority: "AccountDeletionService step mark_account_state: the record that the account was deleted, keyed by user_id",
  },
};

export function resolveFate(node: DeletionGraphNode, policy: DeletionPolicy): Resolution {
  const entry = policy.entries.find((e) => e.table === node.table);
  if (entry) return { resolved: true, fate: entry.fate, source: "policy", authority: entry.authority, entry };

  switch (node.statedFate) {
    case "ERASED_BY_CASCADE":
      return { resolved: true, fate: "DELETE", source: "manifest", authority: "deletionDispositions.ERASED_BY_CASCADE — AccountDeletionService already deletes these rows" };
    case "ANONYMISED_FK_NULLED":
      return { resolved: true, fate: "ANONYMIZE", source: "manifest", authority: "deletionDispositions.ANONYMISED_FK_NULLED — the service already NULLs the identifier and keeps the row" };
    case "RETAINED_WITH_REASON": {
      const r = RETAINED_WITH_REASON.find((x) => x.table === node.table);
      return { resolved: true, fate: "RETAIN", source: "manifest", authority: `deletionDispositions.RETAINED_WITH_REASON: ${r?.reason ?? ""}` };
    }
    case "DELETION_FLOW": {
      const f = FLOW_TABLE_FATES[node.table];
      if (f) return { resolved: true, fate: f.fate, source: "manifest", authority: f.authority };
      return { resolved: false, reason: "DELETION_FLOW table with no cited handling in AccountDeletionService" };
    }
    case "UNCLASSIFIED_BACKLOG":
      return { resolved: false, reason: "UNCLASSIFIED_BACKLOG — survives deletion today and nobody has decided whether it should (owner decision D6)" };
    case "NOT_IN_MANIFEST":
      return {
        resolved: false,
        reason: node.manifestCoverageGap
          ? "carries a foreign key to profiles/auth.users but none of USER_IDENTIFYING_COLUMNS, so check:deletion-coverage never required a fate for it"
          : "absent from every bucket of deletionDispositions.ts",
      };
  }
}

export interface PolicyProblem { table: string; problem: string }

/** A policy is rejected — not warned about — when an entry cannot be audited. */
export function validatePolicy(policy: DeletionPolicy, tables: readonly string[]): PolicyProblem[] {
  const problems: PolicyProblem[] = [];
  const known = new Set(tables);
  const seen = new Set<string>();
  for (const e of policy.entries) {
    if (!e.authority || e.authority.trim() === "") problems.push({ table: e.table, problem: "policy entry has no authority: an unattributed fate is a guess" });
    if (seen.has(e.table)) problems.push({ table: e.table, problem: "named twice in the policy; the later entry would silently win" });
    seen.add(e.table);
    if (!known.has(e.table)) problems.push({ table: e.table, problem: "policy names a table that is not in the deletion graph" });
  }
  return problems;
}
