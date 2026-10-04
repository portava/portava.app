/**
 * creatorLedgerPlans — every creator-ledger operation that spans more than one
 * row, built as ONE payload for `public.creator_ledger_append` (migration 3387).
 * PURE. It reaches no database and moves no money.
 *
 * census-discovery DV-59 (fraud holds — placed AND lifted, explained both
 * ways), DV-60 (historical recalculation), DV-68 (reversals), DV-63 / DV-74
 * (attribution is auditable; admin actions are audited).
 *
 * ── WHY A PAYLOAD AND NOT A SEQUENCE OF WRITES ──────────────────────────────
 * A recomputation is: append a superseding attribution under the new rule
 * version, reverse every live entry of the old one, book the new entries, and
 * record who did it and why. Through PostgREST those are four requests, and a
 * failure between any two leaves a half-ledger — a new rule version with the
 * old money still live, or old money reversed and nothing rebooked. 3387's
 * `creator_ledger_append(jsonb)` is one function call, i.e. one transaction:
 * every row in the payload lands, or none does. This module builds that
 * payload; `services/creators/CreatorLedgerOperations.ts` sends it.
 *
 * ── IDEMPOTENCY KEYS ARE DERIVED FROM WHAT IS ACTED ON ──────────────────────
 * A hold of row R is keyed `creator-attr-hold:<R>`, its release
 * `creator-attr-release:<R>`, a recomputation `creator-attr-recompute:<R>@<v>`.
 * R is a persisted uuid, and 2920's `ca_one_supersede_per_row` lets R be
 * superseded once, so a retried operation replays onto the SAME key (and the
 * database answers it as a replay), while a DIFFERENT operation on the same
 * head collides on the supersession index and is refused as stale. A replay
 * whose content differs from what its key recorded is refused by the door
 * (SQLSTATE CL409), never reported as a replay.
 */
import type { CreatorAttribution } from "./creatorTypeAttribution.js";
import { buildCreatorEarningEntries, type CreatorEarningInput } from "./creatorLedgerEntries.js";
import { isCreatorType } from "./creatorTypes.js";
import {
  beneficiaryIsNamed,
  indexChains,
  toNum,
  type AttributionRow,
  type EarningEntryRow,
} from "./creatorLedgerStatus.js";

// ── The door's payload (3387) ───────────────────────────────────────────────

export interface DoorAttribution {
  creator_type: string;
  subject_kind: string;
  subject_id: string;
  value_event: string;
  value_event_id: string | null;
  attribution_basis: string;
  beneficiary_user_id: string;
  weight: number;
  confidence: number;
  gross_revenue_minor: number;
  provisional_share_minor: number;
  currency: string;
  rule_version: string;
  fraud_hold: boolean;
  fraud_hold_reason: string | null;
  supersedes_id: string | null;
  idempotency_key: string;
  recommendation_id: string | null;
}

/** `attribution_id` is a persisted uuid, or `"$new"` for the payload's own attribution. */
export interface DoorEntry {
  transaction_key: string;
  creator_type: string;
  attribution_id: string;
  account: string;
  entry_reason: string;
  revenue_source: string | null;
  amount_minor: number;
  currency: string;
  rule_version: string;
  beneficiary_user_id: string | null;
  reverses_entry_id: string | null;
  provider: string;
  external_ref: string | null;
  idempotency_key: string;
}

export type AuditAction = "hold_placed" | "hold_released" | "recomputed" | "reversed";

export interface LedgerActor {
  kind: "admin" | "system";
  /** The admin's profile id; null for `system`. */
  userId: string | null;
}

export interface DoorAudit {
  action: AuditAction;
  actor_kind: LedgerActor["kind"];
  actor_user_id: string | null;
  attribution_id: string;
  resulting_attribution_id: string | null;
  reason: string;
  detail: Record<string, unknown>;
  idempotency_key: string;
}

export interface DoorPayload {
  attribution: DoorAttribution | null;
  entries: DoorEntry[];
  audit: DoorAudit | null;
}

export type PlanRefusal =
  | "unknown_attribution"
  | "not_current"
  | "already_held"
  | "not_held"
  | "unexplained"
  | "recompute_while_held"
  | "seam_has_no_computation"
  | "same_rule_version"
  | "unknown_transaction"
  | "already_reversed"
  | "chain_forked"
  /**
   * The row's beneficiary identity was erased and the accounting row retained
   * (C-11 "retain pseudonymised"). There is no party to carry forward, compute
   * for, or book to, so the operation has no subject — permanently. Distinct
   * from `unknown_attribution` (no such row) and from a read that failed.
   */
  | "identity_severed"
  | "refused_by_model";

export type Plan =
  | { ok: true; payload: DoorPayload; subjectId: string }
  | { ok: false; reason: PlanRefusal; detail: string };

const refuse = (reason: PlanRefusal, detail: string): Plan => ({ ok: false, reason, detail });

/** A reason must be SAID. `07` §9 names seven detections; one of them, or a release's cause, must be stated. */
export function normaliseReason(reason: unknown): string | null {
  if (typeof reason !== "string") return null;
  const t = reason.trim();
  return t.length >= 1 && t.length <= 2000 ? t : null;
}

// ── Row ⇄ model ─────────────────────────────────────────────────────────────

/**
 * A persisted attribution row as the pure model's object, so the model's
 * builders can run on it — or an explicit refusal when the row's beneficiary
 * identity has been severed.
 *
 * ── WHY A SEVERED ROW HAS NO MODEL AT ALL ───────────────────────────────────
 * `CreatorAttribution` exists to be RUN, not merely held:
 * `buildCreatorEarningEntries` books the `creator_payable` leg to
 * `beneficiaryUserId`, and `creatorTypeAttribution.ts`'s key builder derives
 * an idempotency key from it. Neither question is answerable for nobody — an
 * earning for no party is not a smaller earning, it is not an earning — so
 * there is no model to hand back, and the honest answer is the state itself,
 * which the caller must handle.
 *
 * The database says the same thing from the other side: once a record is
 * pseudonymised it is FROZEN — no supersession and no new entry against it —
 * so every operation a model would drive is refused there too. Returning a
 * widened model with `beneficiaryUserId: null` would only move this decision
 * into the key builder and the entry builder, where the same coercion would
 * have to be re-made twice more.
 *
 * It is not `""`, not `"unknown"`, and above all not `String(null)` — the
 * string `"null"`, one phantom beneficiary shared by every erased creator.
 */
export type AttributionModel =
  | { ok: true; model: CreatorAttribution }
  | { ok: false; reason: "identity_severed"; detail: string };

export function attributionModelFromRow(row: AttributionRow): AttributionModel {
  if (!beneficiaryIsNamed(row)) {
    return {
      ok: false,
      reason: "identity_severed",
      detail:
        `attribution ${String(row.id)} names no beneficiary: its identity was erased and the accounting ` +
        `row retained, so it has no party to compute an earning for`,
    };
  }
  const creatorType = isCreatorType(row.creator_type) ? row.creator_type : ("travel_partner" as const);
  const basis = row.attribution_basis === "recorded_value_event" ? "recorded_value_event" : "seam_no_producer";
  const model: CreatorAttribution = {
    id: row.idempotency_key,
    creatorType,
    subjectKind: row.subject_kind as CreatorAttribution["subjectKind"],
    subjectId: String(row.subject_id),
    valueEvent: row.value_event as CreatorAttribution["valueEvent"],
    valueEventId: row.value_event_id ? String(row.value_event_id) : null,
    basis,
    beneficiaryUserId: row.beneficiary_user_id,
    weight: toNum(row.weight),
    confidence: toNum(row.confidence),
    grossRevenueMinor: toNum(row.gross_revenue_minor),
    provisionalShareMinor: toNum(row.provisional_share_minor),
    currency: String(row.currency).trim(),
    settledMinor: 0,
    ruleVersion: row.rule_version,
    fraudHold: row.fraud_hold === true,
    fraudHoldReason: row.fraud_hold_reason ?? null,
    supersedesId: row.supersedes_id ?? null,
    earnable: basis === "recorded_value_event" && row.fraud_hold !== true,
    idempotencyKey: row.idempotency_key,
  };
  return { ok: true, model };
}

/**
 * The successor row every supersession starts from: the head's identity,
 * carried forward — or a refusal, when there is no identity left to carry.
 *
 * ── WHY A SEVERED HEAD HAS NO SUCCESSOR ─────────────────────────────────────
 * A supersession IS "the same party's record, restated": 3387's
 * `ca_supersession_is_lawful` admits a successor only when it keeps the head's
 * type, subject AND beneficiary. A severed head has no beneficiary to keep, so
 * no lawful successor exists for it — not a successor with a blank
 * beneficiary, not one with a fresh one, none. `DoorAttribution`'s
 * `beneficiary_user_id` therefore stays non-nullable on purpose: it is the
 * WRITE side, and the C-11 answer forbids ever inserting a row that names
 * nobody (`(beneficiary_user_id IS NULL) <> (beneficiary_pseudonym IS NULL)`,
 * plus a trigger that refuses any insert already carrying a pseudonym).
 *
 * So the chain simply ends. The database agrees from its own side — a
 * pseudonymised record is frozen against supersession — and a hold, a release
 * or a recomputation of such a row is refused here before it is attempted
 * there, with the reason named rather than a write that lands `"null"` in the
 * beneficiary column of a brand-new row.
 */
type Successor =
  | { ok: true; attribution: DoorAttribution }
  | { ok: false; reason: "identity_severed"; detail: string };

function successorOf(head: AttributionRow): Successor {
  if (!beneficiaryIsNamed(head)) {
    return {
      ok: false,
      reason: "identity_severed",
      detail:
        `${String(head.id)} names no beneficiary: its identity was erased and the accounting row retained, ` +
        `so there is no party for a successor to carry forward`,
    };
  }
  const attribution: DoorAttribution = {
    creator_type: head.creator_type,
    subject_kind: head.subject_kind,
    subject_id: String(head.subject_id),
    value_event: head.value_event,
    value_event_id: head.value_event_id ? String(head.value_event_id) : null,
    attribution_basis: head.attribution_basis,
    beneficiary_user_id: head.beneficiary_user_id,
    weight: toNum(head.weight),
    confidence: toNum(head.confidence),
    gross_revenue_minor: toNum(head.gross_revenue_minor),
    provisional_share_minor: toNum(head.provisional_share_minor),
    currency: String(head.currency).trim(),
    rule_version: head.rule_version,
    fraud_hold: head.fraud_hold === true,
    fraud_hold_reason: head.fraud_hold_reason ?? null,
    supersedes_id: String(head.id),
    idempotency_key: "",
    recommendation_id: head.recommendation_id ?? null,
  };
  return { ok: true, attribution };
}

/**
 * The head of `attributionId`'s chain, or a refusal. Operations always act on
 * the HEAD: an admin may name any row of the chain, and what is held, released
 * or recomputed is the attribution's current state, never a historical row.
 */
export function resolveHead(rows: readonly AttributionRow[], attributionId: string):
  { ok: true; head: AttributionRow } | { ok: false; reason: PlanRefusal; detail: string } {
  const chains = indexChains(rows);
  if (chains.forks.length > 0) {
    return { ok: false, reason: "chain_forked", detail: `rows superseded twice: ${chains.forks.join(", ")}` };
  }
  const head = chains.headOf(attributionId);
  if (!head) return { ok: false, reason: "unknown_attribution", detail: attributionId };
  return { ok: true, head };
}

// ── Hold and release (`07` §9/§10) ──────────────────────────────────────────

export function planHold(head: AttributionRow, reasonIn: unknown, actor: LedgerActor): Plan {
  const reason = normaliseReason(reasonIn);
  if (!reason) return refuse("unexplained", "a hold with no reason is indistinguishable from a bug (2920 ca_hold_is_explained)");
  // Severed BEFORE held: a severed record cannot be held OR released, so
  // "already held" would describe a state the admin can do nothing about and
  // hide the one they need to know.
  const carried = successorOf(head);
  if (!carried.ok) return refuse(carried.reason, carried.detail);
  if (head.fraud_hold) return refuse("already_held", `${head.id} is already held for ${head.fraud_hold_reason}`);
  const attribution: DoorAttribution = {
    ...carried.attribution,
    fraud_hold: true,
    fraud_hold_reason: reason,
    idempotency_key: `creator-attr-hold:${head.id}`,
  };
  return {
    ok: true,
    subjectId: String(head.id),
    payload: {
      attribution,
      entries: [],
      audit: {
        action: "hold_placed",
        actor_kind: actor.kind,
        actor_user_id: actor.userId,
        attribution_id: String(head.id),
        resulting_attribution_id: "$new",
        reason,
        detail: { rule_version: head.rule_version, creator_type: head.creator_type },
        idempotency_key: `audit:hold:${head.id}`,
      },
    },
  };
}

/**
 * Lift a hold. The released row carries `fraud_hold = false` and therefore —
 * by 2920's `ca_hold_is_explained` — no reason; WHY it was lifted lives in the
 * audit row, which is written in the same transaction or not at all.
 */
export function planRelease(head: AttributionRow, reasonIn: unknown, actor: LedgerActor): Plan {
  const reason = normaliseReason(reasonIn);
  if (!reason) return refuse("unexplained", "a release with no reason is a hold nobody can account for lifting");
  const carried = successorOf(head);
  if (!carried.ok) return refuse(carried.reason, carried.detail);
  if (!head.fraud_hold) return refuse("not_held", `${head.id} is not held`);
  const attribution: DoorAttribution = {
    ...carried.attribution,
    fraud_hold: false,
    fraud_hold_reason: null,
    idempotency_key: `creator-attr-release:${head.id}`,
  };
  return {
    ok: true,
    subjectId: String(head.id),
    payload: {
      attribution,
      entries: [],
      audit: {
        action: "hold_released",
        actor_kind: actor.kind,
        actor_user_id: actor.userId,
        attribution_id: String(head.id),
        resulting_attribution_id: "$new",
        reason,
        detail: { released_hold_reason: head.fraud_hold_reason, rule_version: head.rule_version },
        idempotency_key: `audit:release:${head.id}`,
      },
    },
  };
}

// ── Reversal (`09` §6) ──────────────────────────────────────────────────────

/** The live (non-reversal, not-yet-reversed) entries among `entries`. */
export function liveEntries(entries: readonly EarningEntryRow[]): EarningEntryRow[] {
  const reversed = new Set(entries.map((e) => e.reverses_entry_id).filter((x): x is string => !!x));
  return entries.filter((e) => e.entry_reason !== "reversal" && !reversed.has(String(e.id)));
}

/** The exact negation of each persisted entry, linked by its uuid. */
function reversalOf(e: EarningEntryRow): DoorEntry {
  return {
    transaction_key: `reversal:${e.transaction_key}`,
    creator_type: e.creator_type,
    attribution_id: String(e.attribution_id),
    account: e.account,
    entry_reason: "reversal",
    revenue_source: e.revenue_source ?? null,
    amount_minor: -toNum(e.amount_minor),
    currency: String(e.currency).trim(),
    // The version of the entry being reversed, not today's: a reversal is a
    // fact about the OLD computation and must read back under it.
    rule_version: e.rule_version,
    beneficiary_user_id: e.beneficiary_user_id ?? null,
    reverses_entry_id: String(e.id),
    provider: e.provider ?? "none",
    external_ref: null,
    idempotency_key: `reversal:${e.idempotency_key}`,
  };
}

export function planReversal(
  entries: readonly EarningEntryRow[],
  transactionKey: string,
  reasonIn: unknown,
  actor: LedgerActor,
): Plan {
  const reason = normaliseReason(reasonIn);
  if (!reason) return { ok: false, reason: "unexplained", detail: "a reversal with no reason cannot be audited" };
  const originals = entries.filter((e) => e.transaction_key === transactionKey);
  if (originals.length === 0) return { ok: false, reason: "unknown_transaction", detail: transactionKey };
  const reversed = new Set(entries.map((e) => e.reverses_entry_id).filter((x): x is string => !!x));
  if (originals.some((e) => reversed.has(String(e.id)))) {
    return { ok: false, reason: "already_reversed", detail: transactionKey };
  }
  const first = originals[0]!;
  return {
    ok: true,
    subjectId: String(first.attribution_id),
    payload: {
      attribution: null,
      entries: originals.map(reversalOf),
      audit: {
        action: "reversed",
        actor_kind: actor.kind,
        actor_user_id: actor.userId,
        attribution_id: String(first.attribution_id),
        resulting_attribution_id: null,
        reason,
        detail: { transaction_key: transactionKey, legs: originals.length },
        idempotency_key: `audit:reverse:${transactionKey}`,
      },
    },
  };
}

// ── Recomputation (`07` §10) ────────────────────────────────────────────────

/**
 * Recompute one attribution's earning under a NEW rule version, as one
 * payload: the superseding attribution, the reversal of every live entry in
 * the chain, the new entries, and the audit row.
 *
 * `next` is what `lib/creatorRuleEvaluation.ts` computed from the new
 * version's PUBLISHED params; this function computes no percentage.
 */
export function planRecompute(
  chain: readonly AttributionRow[],
  entries: readonly EarningEntryRow[],
  head: AttributionRow,
  next: { ruleVersion: string; figures: CreatorEarningInput },
  reasonIn: unknown,
  actor: LedgerActor,
): Plan {
  const reason = normaliseReason(reasonIn);
  if (!reason) return refuse("unexplained", "a recomputation with no reason cannot be audited");
  // Severed first: "release it before recomputing" is advice an admin cannot
  // take on a severed record, because the release is refused for the same reason.
  const carried = successorOf(head);
  if (!carried.ok) return refuse(carried.reason, carried.detail);
  if (head.fraud_hold) return refuse("recompute_while_held", `${head.id} is held; release it before recomputing`);
  if (head.attribution_basis !== "recorded_value_event") {
    return refuse("seam_has_no_computation", `${head.id} is a seam: no value event, nothing to recompute`);
  }
  if (next.ruleVersion === head.rule_version) {
    return refuse("same_rule_version", `${head.id} is already at ${head.rule_version}`);
  }

  const key = `creator-attr-recompute:${head.id}@${next.ruleVersion}`;
  const attribution: DoorAttribution = {
    ...carried.attribution,
    rule_version: next.ruleVersion,
    gross_revenue_minor: next.figures.grossRevenueMinor,
    provisional_share_minor: next.figures.creatorShareMinor,
    fraud_hold: false,
    fraud_hold_reason: null,
    idempotency_key: key,
  };

  const chainIds = new Set(chain.map((r) => String(r.id)));
  const chainEntries = entries.filter((e) => chainIds.has(String(e.attribution_id)));
  const reversals = liveEntries(chainEntries).map(reversalOf);

  // The new entries, built by the SAME model every other earning is built by,
  // against the new row as a model object whose id is its idempotency key.
  const model = attributionModelFromRow({ ...head, ...attribution, id: key, idempotency_key: key } as AttributionRow);
  if (!model.ok) return refuse(model.reason, model.detail);
  const built = buildCreatorEarningEntries(model.model, next.figures);
  if (built.status !== "built") return refuse("refused_by_model", `${built.reason}: ${built.detail}`);
  const fresh: DoorEntry[] = built.entries.map((e) => ({
    transaction_key: e.transactionKey,
    creator_type: e.creatorType,
    attribution_id: "$new",
    account: e.account,
    entry_reason: e.entryReason,
    revenue_source: e.revenueSource,
    amount_minor: e.amountMinor,
    currency: e.currency,
    rule_version: e.ruleVersion,
    beneficiary_user_id: e.beneficiaryUserId,
    reverses_entry_id: null,
    provider: e.provider,
    external_ref: e.externalRef,
    idempotency_key: e.idempotencyKey,
  }));

  return {
    ok: true,
    subjectId: String(head.id),
    payload: {
      attribution,
      entries: [...reversals, ...fresh],
      audit: {
        action: "recomputed",
        actor_kind: actor.kind,
        actor_user_id: actor.userId,
        attribution_id: String(head.id),
        resulting_attribution_id: "$new",
        reason,
        detail: {
          from_rule_version: head.rule_version,
          to_rule_version: next.ruleVersion,
          reversed_entries: reversals.length,
          booked_entries: fresh.length,
          gross_revenue_minor: next.figures.grossRevenueMinor,
          creator_share_minor: next.figures.creatorShareMinor,
          platform_fee_minor: next.figures.platformFeeMinor,
        },
        idempotency_key: `audit:recompute:${head.id}@${next.ruleVersion}`,
      },
    },
  };
}
