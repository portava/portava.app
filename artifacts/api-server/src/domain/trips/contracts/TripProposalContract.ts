/**
 * Trips spec §9.3 — the `TripProposal` contract (census-trips TR153), as ONE
 * shape over the storage that carries it.
 *
 *   TripProposal { type, proposedBy, affectedObjects[], rationale,
 *                  impactSummary, decisionRule, status, expiresAt }
 *
 * WHAT WAS TRUE BEFORE THIS FILE
 * ==============================
 * Three of the eight were columns from 2763 (`proposal_type`, `status`,
 * `expires_at`); 2774 made two more columns (`decision_rule`, `proposed_by`)
 * and put the remaining three in `payload_json` deliberately:
 *
 *   "affectedObjects / rationale / impactSummary — payload_json, under
 *    documented keys. Nothing enforces them, they vary by proposal type, and
 *    a column each would freeze a shape §9.3 does not fix."
 *
 * The keys were never documented anywhere. Two writers existed and NEITHER
 * wrote any of the three — the replan route writes `{ op, planId, title, from,
 * to, reason, detail, ... }` and Compass writes the caller's change object
 * verbatim — while the one reader guessed at two spellings
 * (`affected_objects ?? affectedObjects`) and never looked for the other two at
 * all. So the contract was eight fields of which five could not be read back,
 * and that is why TR153 stayed W after 2774 landed. This file is the
 * documentation 2774 pointed at, made executable: the keys exist once, the
 * writers build the payload through `proposalContractPayload` and the reader
 * takes it apart through `readTripProposal`, so a new writer cannot invent a
 * sixth spelling without changing this file.
 *
 * PURE. No client, no flag, no I/O — a row in, a contract out.
 *
 * WHAT THIS FILE DOES NOT DO. It does not make the three payload fields
 * REQUIRED. §9.3 does not say every proposal carries a rationale, 2774 says
 * nothing enforces them, and a contract that invented an empty string for an
 * unrecorded rationale would be worse than one that says it is absent.
 */

/** 2763's `trip_proposals_type_known`. */
export const TRIP_PROPOSAL_TYPES = [
  "add_plan", "move_plan", "cancel_plan", "add_commitment", "stage_change", "other",
] as const;

/** 2763's `trip_proposals_status_known`. */
export const TRIP_PROPOSAL_STATUSES = [
  "pending", "accepted", "rejected", "expired", "superseded",
] as const;

/** 2774's `trip_proposals_decision_rule_known` — §9.3's four rules. */
export const TRIP_PROPOSAL_DECISION_RULES = ["host", "majority", "unanimous", "anyone"] as const;
export type TripProposalDecisionRule = (typeof TRIP_PROPOSAL_DECISION_RULES)[number];

/**
 * The three §9.3 fields that live in `payload_json`, and the ONE key each is
 * written under. snake_case, matching every column name around them, so a
 * reader scanning the row and the payload together is not switching
 * conventions halfway.
 */
export const TRIP_PROPOSAL_PAYLOAD_KEYS = {
  affectedObjects: "affected_objects",
  rationale: "rationale",
  impactSummary: "impact_summary",
} as const;

/**
 * The camelCase spellings ALSO accepted on read, per field.
 *
 * Not symmetry for its own sake: `routes/tripDecisions.ts` has been reading
 * `affectedObjects` since before this file, and §9.3 itself names the fields
 * in camelCase, so rows written by anything that took the spec literally are
 * already out there. Read both, write one — a reader that accepted only the
 * canonical key would silently drop those rows' affected objects, which is the
 * failure this contract exists to stop.
 */
const READ_ALIASES: Readonly<Record<keyof typeof TRIP_PROPOSAL_PAYLOAD_KEYS, readonly string[]>> = {
  affectedObjects: ["affected_objects", "affectedObjects"],
  rationale: ["rationale"],
  impactSummary: ["impact_summary", "impactSummary"],
};

export interface TripProposalContract {
  id: string;
  tripId: string | null;
  /** §9.3 `type` — 2763's `proposal_type`. */
  type: string;
  /**
   * §9.3 `proposedBy` — 2774's column.
   *
   * `null` is AMBIGUOUS by 2774's own design (the column is nullable so a
   * deleted account's proposal survives with its author unset) and it is also
   * what a pre-2774 database gives. Either way the honest reading is the same:
   * the author is not known, so a majority or unanimous tally may not exclude
   * or include them. It is never defaulted to the caller.
   */
  proposedBy: string | null;
  /** §9.3 `affectedObjects[]` — payload. Empty means none recorded. */
  affectedObjects: string[];
  /** §9.3 `rationale` — payload. `null` means not recorded. */
  rationale: string | null;
  /** §9.3 `impactSummary` — payload. `null` means not recorded. */
  impactSummary: string | null;
  /**
   * §9.3 `decisionRule` — 2774's column.
   *
   * `null` means the column was NOT READ: a pre-2774 database, or a select
   * that did not name it. It is deliberately NOT defaulted to `host`, even
   * though that is 2774's column default, because a governance rule a reader
   * INVENTED is the one field on this contract that decides who may accept the
   * proposal. A caller that sees null must refuse to close the proposal, not
   * fall back to the most permissive — or the most restrictive — rule.
   */
  decisionRule: TripProposalDecisionRule | null;
  /** §9.3 `status` — 2763's column. */
  status: string;
  /** §9.3 `expiresAt` — 2763's column; null when the proposal does not expire. */
  expiresAt: string | null;
  /** 2763's optimistic-concurrency anchor; not one of §9.3's eight, carried because a consumer deciding a proposal needs it. */
  affectedVersion: number | null;
  /** Everything else in `payload_json`, untouched — the type-specific change §9.3 does not fix a shape for. */
  payload: Record<string, unknown>;
}

/** A `trip_proposals` row as PostgREST hands it back. Every field optional: a narrowed select is a fact about the query, not about the row. */
export interface TripProposalRow {
  id?: unknown;
  trip_id?: unknown;
  proposal_type?: unknown;
  status?: unknown;
  expires_at?: unknown;
  affected_version?: unknown;
  decision_rule?: unknown;
  proposed_by?: unknown;
  payload_json?: unknown;
}

function stringOrNull(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

/** Ids only, and only strings. A non-string in an id array is dropped rather than stringified: `[object Object]` is not an object anyone can look up. */
function idArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.length > 0) : [];
}

function firstPresent(payload: Record<string, unknown>, keys: readonly string[]): unknown {
  for (const k of keys) if (k in payload) return payload[k];
  return undefined;
}

/**
 * A row (and its payload) as §9.3's contract.
 *
 * Total: never throws, whatever the row carries. A malformed field becomes the
 * contract's "not recorded" value for that field rather than taking down the
 * whole read — one bad payload must not cost a crew every proposal on the
 * trip.
 */
export function readTripProposal(row: TripProposalRow): TripProposalContract {
  const payload = row.payload_json && typeof row.payload_json === "object" && !Array.isArray(row.payload_json)
    ? { ...(row.payload_json as Record<string, unknown>) }
    : {};

  const rule = stringOrNull(row.decision_rule);
  const decisionRule = rule !== null && (TRIP_PROPOSAL_DECISION_RULES as readonly string[]).includes(rule)
    ? rule as TripProposalDecisionRule
    // An UNRECOGNISED rule is `null` for the same reason an unread one is:
    // 2774's own header says an unconstrained rule "can hold any string,
    // including one no branch handles, and the safest behaviour for an unknown
    // rule is not something a ->> can express." Here it is expressible, and it
    // is "I do not know how this is decided".
    : null;

  // The contract's three payload fields are LIFTED out of `payload`, so a
  // consumer spreading `payload` cannot also see them under a raw key and
  // treat the two as independent.
  const rest = { ...payload };
  for (const aliases of Object.values(READ_ALIASES)) for (const k of aliases) delete rest[k];

  return {
    id: String(row.id ?? ""),
    tripId: stringOrNull(row.trip_id),
    type: stringOrNull(row.proposal_type) ?? "other",
    proposedBy: stringOrNull(row.proposed_by),
    affectedObjects: idArray(firstPresent(payload, READ_ALIASES.affectedObjects)),
    rationale: stringOrNull(firstPresent(payload, READ_ALIASES.rationale)),
    impactSummary: stringOrNull(firstPresent(payload, READ_ALIASES.impactSummary)),
    decisionRule,
    status: stringOrNull(row.status) ?? "pending",
    expiresAt: stringOrNull(row.expires_at),
    affectedVersion: typeof row.affected_version === "number" ? row.affected_version : null,
    payload: rest,
  };
}

/**
 * The write half: the `payload_json` a CREATE_PROPOSAL command carries.
 *
 * `change` is the type-specific body §9.3 leaves open. The three contract
 * fields are written LAST and under the canonical keys, so a `change` that
 * happens to carry its own `rationale` cannot end up as a second, disagreeing
 * rationale beside the one the caller meant.
 *
 * A field the caller does not supply is OMITTED, not written as null: the
 * contract reads an absent key as "not recorded", and an explicit null would
 * be a record that there is no rationale — a different claim.
 */
export function proposalContractPayload(
  change: Record<string, unknown>,
  contract: { affectedObjects?: readonly string[] | null; rationale?: string | null; impactSummary?: string | null },
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...change };
  for (const aliases of Object.values(READ_ALIASES)) for (const k of aliases) delete out[k];

  const affected = contract.affectedObjects ? idArray([...contract.affectedObjects]) : [];
  if (affected.length > 0) out[TRIP_PROPOSAL_PAYLOAD_KEYS.affectedObjects] = affected;
  const rationale = stringOrNull(contract.rationale);
  if (rationale !== null) out[TRIP_PROPOSAL_PAYLOAD_KEYS.rationale] = rationale;
  const impact = stringOrNull(contract.impactSummary);
  if (impact !== null) out[TRIP_PROPOSAL_PAYLOAD_KEYS.impactSummary] = impact;
  return out;
}

/**
 * The DOOR half (census-trips TR153): a CREATE_PROPOSAL command's payload as
 * `POST /trips/:tripId/commands` hands it to the kernel.
 *
 * The two server writers build `payload_json` through `proposalContractPayload`,
 * but both run only under `trip_kernel_enabled`. The commands endpoint issues
 * CREATE_PROPOSAL whatever that flag says, and it passed a caller's
 * `payload_json` through verbatim — so on every deployment the one proposal
 * writer that runs could store `affectedObjects` as a string, a rationale as a
 * number, or two disagreeing spellings of one field, and the contract's
 * "a new writer cannot invent a sixth spelling" held everywhere except there.
 *
 * Here the three payload fields are validated and re-written under their ONE
 * key, through the same `proposalContractPayload` the server writers use. A
 * malformed field is REFUSED with its name rather than dropped: a caller who
 * sent a rationale and had it silently discarded would believe the crew can
 * read it. `null` is "not recorded" and is omitted, as the writer does. A
 * payload with none of the three fields, or with no `payload_json`, is returned
 * as the caller sent it. Every other key is left to the kernel, which owns it.
 */
export type ProposalCommandPayload =
  | { ok: true; payload: unknown }
  | { ok: false; message: string };

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

export function proposalCommandPayload(raw: unknown): ProposalCommandPayload {
  if (!isPlainObject(raw) || raw.payload_json === undefined || raw.payload_json === null) return { ok: true, payload: raw };
  const change = raw.payload_json;
  if (!isPlainObject(change)) return { ok: false, message: "payload_json must be an object" };
  if (!Object.values(READ_ALIASES).some((aliases) => aliases.some((k) => k in change))) return { ok: true, payload: raw };

  const fields: { affectedObjects?: string[] | null; rationale?: string | null; impactSummary?: string | null } = {};
  for (const [field, aliases] of Object.entries(READ_ALIASES) as Array<[keyof typeof TRIP_PROPOSAL_PAYLOAD_KEYS, readonly string[]]>) {
    const canonical = TRIP_PROPOSAL_PAYLOAD_KEYS[field];
    const given = aliases.filter((k) => k in change && change[k] !== null && change[k] !== undefined);
    if (given.length > 1 && new Set(given.map((k) => JSON.stringify(change[k]))).size > 1) {
      return { ok: false, message: `${canonical} is given under ${given.join(" and ")} with different values` };
    }
    if (given.length === 0) continue;
    const v = change[given[0]!];
    if (field === "affectedObjects") {
      if (!Array.isArray(v) || !v.every((x) => typeof x === "string" && x.length > 0)) {
        return { ok: false, message: `${canonical} must be an array of ids` };
      }
      fields.affectedObjects = v as string[];
    } else {
      if (typeof v !== "string") return { ok: false, message: `${canonical} must be text` };
      fields[field] = v;
    }
  }
  return { ok: true, payload: { ...raw, payload_json: proposalContractPayload(change, fields) } };
}
