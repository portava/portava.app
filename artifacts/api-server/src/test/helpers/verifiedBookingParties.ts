/**
 * A fixture for the booking-creation tests whose SUBJECT is another gate (kill
 * switches, launch controls, blocks, rollout, parity between the five paths).
 *
 * Since 2026-10-05 every creation path also requires BOTH people to hold a
 * current REAL identity verification, be verified adults, and carry no Trust
 * restriction covering the action (lib/rentBuddyIdentityEligibility.ts — owner
 * ruling 2026-10-04, "No unverified bookings"). Those suites' hand-rolled fakes
 * predate the rule and answer nothing for it, so every booking they expected to
 * reach a LATER gate now stops at this one. This wrapper states the missing
 * fact — "these people are verified" — in the shape the real readers query, and
 * nothing else:
 *
 *   identity_verifications, selected with CURRENT_VERIFICATION_COLUMNS
 *     -> one live, verified, adult attempt for a listed user, else none
 *   profiles, selected as exactly "verification_level"
 *     -> 'id_verified' for a listed user (other profiles selects pass through)
 *   trust_restrictions (select "restriction_type")
 *     -> the user's active restriction types from `restrictions`, else none
 *
 * Every other query — including the verified-MINOR read
 * (lib/travelerVerification.ts readVerifiedAgeSignal, a different select) —
 * reaches the suite's own fake untouched, so a suite that seeds a minor still
 * gets its refusal. The REAL readers run: this supplies rows, it does not stub
 * the decision. `test/rentBuddyIdentityEligibility.test.ts` proves the decision
 * itself, including every refusal.
 */
import { CURRENT_VERIFICATION_COLUMNS } from "../../services/identityVerification/currentVerification.js";

type Row = Record<string, unknown>;

function rowsBuilder(rowsFor: (filters: Record<string, unknown>) => Row[]) {
  const filters: Record<string, unknown> = {};
  let single = false;
  let limit = Infinity;
  const result = () => {
    const rows = rowsFor(filters).slice(0, limit);
    return single ? { data: rows[0] ?? null, error: null } : { data: rows, error: null };
  };
  const q: any = {
    select: () => q,
    eq: (c: string, v: unknown) => { filters[c] = v; return q; },
    in: () => q,
    is: () => q,
    or: () => q,
    order: () => q,
    limit: (n: number) => { limit = n; return q; },
    maybeSingle: async () => { single = true; return result(); },
    single: async () => { single = true; return result(); },
    then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => Promise.resolve(result()).then(resolve, reject),
  };
  return q;
}

export interface VerifiedPartiesOptions {
  /** Active Trust restriction types per user id (e.g. { [buddy]: ["hosting"] }). */
  restrictions?: Record<string, string[]>;
}

/**
 * Wrap a fake supabase client so the listed users read as verified adults. The
 * wrapper keeps every other property of the client (auth, rpc, …).
 */
export function withVerifiedBookingParties<C extends { from: (t: string) => any }>(
  client: C,
  verifiedUserIds: readonly string[] | "everyone",
  options: VerifiedPartiesOptions = {},
): C {
  const listed = new Set(verifiedUserIds === "everyone" ? [] : verifiedUserIds);
  const verified = { has: (id: string) => verifiedUserIds === "everyone" || listed.has(id) };
  const wrapped = Object.create(client) as C;
  (wrapped as any).from = (table: string) => {
    const inner = client.from(table);
    if (table !== "identity_verifications" && table !== "profiles" && table !== "trust_restrictions") return inner;
    const select = (columns?: string, ...rest: unknown[]) => {
      if (table === "identity_verifications" && columns === CURRENT_VERIFICATION_COLUMNS) {
        return rowsBuilder((f) =>
          verified.has(String(f["user_id"]))
            ? [{
                id: `iv-${String(f["user_id"])}`, provider: "stripe", provider_mode: "live", status: "verified",
                is_over_18: true, document_country: "US", verified_at: "2026-09-01T00:00:00.000Z", created_at: "2026-09-01T00:00:00.000Z",
              }]
            : [],
        );
      }
      if (table === "profiles" && columns === "verification_level") {
        return rowsBuilder((f) => (verified.has(String(f["id"])) ? [{ verification_level: "id_verified" }] : [{ verification_level: "none" }]));
      }
      if (table === "trust_restrictions" && columns === "restriction_type") {
        return rowsBuilder((f) => (options.restrictions?.[String(f["user_id"])] ?? []).map((t) => ({ restriction_type: t })));
      }
      return inner.select(columns, ...rest);
    };
    // A Proxy, not a spread: the suites' fakes keep state on `this`, and some are
    // class instances whose methods a spread would drop.
    return new Proxy(inner, {
      get(target, prop) {
        if (prop === "select") return select;
        const v = Reflect.get(target, prop, target);
        return typeof v === "function" ? v.bind(target) : v;
      },
    });
  };
  return wrapped;
}
