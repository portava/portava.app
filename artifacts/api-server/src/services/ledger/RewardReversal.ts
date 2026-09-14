/**
 * RewardReversal — the compensating entry for public.intel_reward_ledger.
 *
 * ── THE PROPERTY, AND WHY IT WAS VIOLATED ───────────────────────────────────
 * `09` §11: *"Payment architecture is ready BEFORE PAYOUTS when … reversals are
 * possible."* On the one ledger this tree actually books earnings to, they were
 * not. `2170` grants service_role INSERT + SELECT and nothing else, so a booked
 * row is immutable — which is right, and is why `09` §1.5 calls this table the
 * closest thing in the repository to a real ledger. But `2170:38-39` also carry
 *
 *     qiu          numeric NOT NULL DEFAULT 0 CHECK (qiu >= 0)
 *     earned_units integer NOT NULL DEFAULT 0 CHECK (earned_units >= 0)
 *
 * and immutability plus non-negativity leaves NO representation of an opposite.
 * No UPDATE, no DELETE, no negative row: a credit booked in error stands for
 * ever. `2180:6-12` names the very defect this creates — an at-least-once caller
 * booking the same earning twice on an append-only ledger *"with no way to
 * reverse it"* — and solves only the duplicate half.
 *
 * ── IT IS NOT HYPOTHETICAL ──────────────────────────────────────────────────
 * `lib/intelRewardScheduler.ts` books a credit the moment a contributor's
 * observation reaches the SERVED live state, and its `alreadyRewarded`
 * anti-join then never reconsiders it. With `intel_outcome_attribution_enabled`
 * ON, a traveller can afterwards report an outcome that CONTRADICTS that served
 * state — `classifyAttribution` returns `"contradicted"`
 * (`services/intel/RewardOracle.ts:140-148`). The contribution was rewarded for
 * being right about the world; the world says otherwise; and nothing can take
 * the credit back.
 *
 * ── THE FIX IS A NEW ROW, NEVER AN EDIT ─────────────────────────────────────
 * Migration `2900` supersedes the two CHECKs with a sign-BY-ROLE constraint: an
 * ORIGINAL entry (`reverses_entry_id IS NULL`) is still non-negative, and only a
 * row that NAMES the entry it reverses may be negative. Nothing becomes mutable;
 * the grants are untouched; `CHECK (cash_amount = 0)` is untouched. This is the
 * same principle `2277:36-40` already states for derived attribution data — a
 * correction is a new row, never a rewrite — and `09` §9.2's definition of a
 * reversal: *"Always a new transaction whose entries are the negation of the
 * original… **Never** a DELETE."*
 *
 * ── AT MOST ONCE ────────────────────────────────────────────────────────────
 * Reversing twice re-credits an earning that only ever existed once. The
 * database enforces one reversal per entry with a partial unique index on
 * `reverses_entry_id`, and — following `2180:17-19`, which records that
 * PostgREST conflict-target inference does NOT match a partial index — the
 * 23505 is caught in code and treated as a REPLAY, exactly the control flow at
 * `services/intel/RewardService.ts:77-91`.
 *
 * NON-CASH THROUGHOUT. Reversing a non-cash credit is non-cash. No money moves
 * here, in either direction: `09` §1, "Portava moves no money", is unchanged.
 *
 * RUNTIME EFFECT: NONE until `intel_rewards` is enabled — the flag is read
 * fail-closed before anything is read or written. The shipping caller is the
 * reward worker, `lib/intelRewardScheduler.ts#runIntelRewardPass`.
 */
import { isFlagEnabled } from "../../lib/featureFlags.js";

const REWARDS_FLAG = "intel_rewards";
const LEDGER = "intel_reward_ledger";

/** `reversal:<entry-id>` — derived from the EVENT, not the attempt (`09` §7.1). */
export const reversalKeyFor = (originalEntryId: string): string => `reversal:${originalEntryId}`;

export interface ReverseRewardInput {
  /** intel_reward_ledger.id of the entry being compensated. */
  originalEntryId: string;
  /** Why. Recorded on the row, so a debit is never unexplained. */
  reason: string;
}

export type ReverseRewardResult =
  | { ok: true; ledgerEntry: any; reversedUnits: number; replayed?: true }
  | {
      ok: false;
      reason: "disabled" | "not_found" | "not_reversible" | "db_error";
      detail?: string;
    };

const num = (v: unknown): number => {
  const n = typeof v === "string" ? Number(v) : (v as number);
  return Number.isFinite(n) ? n : 0;
};

/**
 * Book the compensating entry for one reward-ledger row.
 *
 * Refuses — writing nothing — when the flag is off, when the entry does not
 * exist, when the target is ITSELF a reversal, or when the target somehow
 * carries cash. Idempotent: a redelivery returns the original reversal rather
 * than debiting twice.
 */
export async function reverseEarnedReward(
  sc: any,
  input: ReverseRewardInput,
): Promise<ReverseRewardResult> {
  if (!(await isFlagEnabled(sc, REWARDS_FLAG))) return { ok: false, reason: "disabled" };

  const id = typeof input.originalEntryId === "string" ? input.originalEntryId.trim() : "";
  if (id.length === 0) {
    return { ok: false, reason: "not_found", detail: "no entry id supplied" };
  }

  const { data: original, error: readErr } = await sc
    .from(LEDGER)
    .select("id, actor_id, qiu, earned_units, cash_amount, ledger_version, commercial_use_permission, reverses_entry_id")
    .eq("id", id)
    .maybeSingle();
  if (readErr) {
    return { ok: false, reason: "db_error", detail: String((readErr as any).message ?? readErr) };
  }
  if (!original) return { ok: false, reason: "not_found", detail: id };

  // A reversal of a reversal re-credits an earning that existed once. The
  // partial unique index stops the SAME entry being reversed twice; this stops
  // the chain being walked forwards instead.
  if ((original as any).reverses_entry_id != null) {
    return { ok: false, reason: "not_reversible", detail: "target is itself a reversal" };
  }
  // Defence in depth for the financial-control boundary. `2170:40` makes a
  // non-zero cash_amount impossible; if one is ever read back, this refuses
  // rather than negating a cash figure it was never meant to touch.
  if (num((original as any).cash_amount) !== 0) {
    return { ok: false, reason: "not_reversible", detail: "target carries a non-zero cash_amount" };
  }

  const key = reversalKeyFor(id);
  const row = {
    actor_id: (original as any).actor_id,
    source: `reversal:${input.reason}`,
    qiu: -num((original as any).qiu),
    earned_units: -num((original as any).earned_units),
    cash_amount: 0, // never platform cash, in either direction
    // The reversal is a fact about the computation it undoes, so it reads back
    // under that computation's rules — not under whatever is current now.
    ledger_version: (original as any).ledger_version,
    commercial_use_permission: (original as any).commercial_use_permission === true,
    reverses_entry_id: id,
    idempotency_key: key,
  };

  const { data, error } = await sc.from(LEDGER).insert(row).select().single();
  if (!error) {
    return { ok: true, ledgerEntry: data, reversedUnits: row.earned_units };
  }

  // 23505 ⇒ this entry is already reversed. Read the original reversal back and
  // return it: the debit is booked exactly once. (`2180:17-19` — do NOT try
  // PostgREST on_conflict inference here; the index is partial.)
  if (String((error as any).code) === "23505") {
    const { data: existing, error: replayErr } = await sc
      .from(LEDGER)
      .select()
      .eq("reverses_entry_id", id)
      .maybeSingle();
    if (!replayErr && existing) {
      return {
        ok: true,
        ledgerEntry: existing,
        reversedUnits: num((existing as any).earned_units),
        replayed: true,
      };
    }
    return { ok: false, reason: "db_error", detail: "reversal replay lookup failed" };
  }
  return { ok: false, reason: "db_error", detail: String((error as any).message ?? error) };
}

// ── The derived balance ─────────────────────────────────────────────────────

export interface RewardBalance {
  earnedUnits: number;
  qiu: number;
  /** Always 0. Present so a reader can assert it rather than assume it. */
  cashAmount: number;
}

export interface RewardLedgerRowLike {
  earned_units?: number | string | null;
  qiu?: number | string | null;
  cash_amount?: number | string | null;
  reverses_entry_id?: string | null;
}

/**
 * `09` §11: *"no balance depends on mutable totals."* A contributor's standing
 * is a FOLD over their ledger rows — originals positive, reversals negative —
 * and never a stored counter anybody maintains. Addition is commutative, so the
 * answer cannot depend on the order the rows come back in; that is the property
 * the test quantifies over rather than illustrates.
 */
export function reconstructRewardBalance(rows: readonly RewardLedgerRowLike[]): RewardBalance {
  let earnedUnits = 0;
  let qiu = 0;
  let cashAmount = 0;
  for (const r of rows) {
    earnedUnits += num(r.earned_units);
    qiu += num(r.qiu);
    cashAmount += num(r.cash_amount);
  }
  return { earnedUnits, qiu: Math.round(qiu * 1e6) / 1e6, cashAmount };
}
