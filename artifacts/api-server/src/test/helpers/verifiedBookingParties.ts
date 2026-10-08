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
 *   payment_parties (select "id") + rent_buddy_payment_recipients
 *     -> since OD-PAY-10's second half (services/payments/bookingPayments/
 *        recipientReadiness.ts): a listed user has a payment party and a
 *        recipient row with onboarding 'verified' and charges enabled, unless
 *        `payments` says otherwise; an unlisted user has no party
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
  /** The buddy's payment-provider state per user id, when it is not "ready" (the default for a listed user). */
  payments?: Record<string, "no_party" | "no_recipient" | "onboarding_incomplete" | "charges_disabled" | "unreadable">;
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
    if (table === "payment_parties" || table === "rent_buddy_payment_recipients") return paymentRead(table, verified, options);
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

const PARTY_PREFIX = "party-";

/** The two payment reads, answered for the listed users (no suite's fake knows these tables). */
function paymentRead(table: string, verified: { has(id: string): boolean }, options: VerifiedPartiesOptions) {
  const unreadable = () => {
    const q: any = rowsBuilder(() => []);
    const fail = async () => ({ data: null, error: { message: "relation does not exist", code: "PGRST205" } });
    q.maybeSingle = fail; q.single = fail;
    q.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => fail().then(resolve, reject);
    return q;
  };
  const q: any = {
    select: (_columns?: string) => q,
    eq: (col: string, value: unknown) => {
      if (table === "payment_parties" && col === "profile_id") {
        const id = String(value);
        const st = options.payments?.[id];
        if (st === "unreadable") return unreadable();
        return rowsBuilder(() => (verified.has(id) && st !== "no_party" ? [{ id: `${PARTY_PREFIX}${id}` }] : []));
      }
      if (table === "rent_buddy_payment_recipients" && col === "party_id") {
        const id = String(value).slice(PARTY_PREFIX.length);
        const st = options.payments?.[id];
        if (st === "no_recipient") return rowsBuilder(() => []);
        return rowsBuilder(() => [{
          party_id: String(value), provider: "fake", recipient_ref: `fake_acct_${id}`, country: "US", settlement_currency: "USD",
          onboarding: st === "onboarding_incomplete" ? "in_progress" : "verified", charges_enabled: st !== "charges_disabled",
          payouts_enabled: st !== "charges_disabled", requirements_due: [], provider_updated_at: null,
        }]);
      }
      return rowsBuilder(() => []);
    },
  };
  return q;
}
