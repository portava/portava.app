/**
 * Phase 4 — Social Identity backend (recipient/user search, @mentions,
 * #hashtags, §23 username validation) wired through the Phase-1 gateway.
 *
 * Run: node --import tsx/esm --test src/test/inputAssistanceSocialIdentity.test.ts
 *
 * Style: direct calls into the gateway + social resolvers with an injected fake
 * client (no HTTP listener). Proves:
 *   - recipient search returns eligible contacts with a resolvable action;
 *   - a BLOCKED contact is suppressed (block gate — mutation-proof);
 *   - a non-eligible/private account is NOT revealed (eligibility filter —
 *     mutation-proof);
 *   - a stranger's private account never enters recipient search (§47
 *     structural enumeration protection);
 *   - an @mention resolves to a user_id and a #hashtag to its canonical slug,
 *     each as a structured reference (§26);
 *   - §23 username validation reports availability / taken / reserved;
 *   - fail-closed: an unreadable block-set yields no recipients (§29).
 *
 * MUTATION-PROOFS (documented inline):
 *   A. socialIdentity.resolveRecipientSuggestions block gate — replacing
 *      `.filter((id) => !blockedSet.has(id))` with `.filter(() => true)` makes
 *      the "blocked contact suppressed" test RED.
 *   B. socialIdentity.resolveRecipientSuggestions eligibility filter — replacing
 *      `capped.filter((_, i) => verdicts[i].verdict !== 'denied')` with `capped`
 *      makes the "non-eligible account not revealed" test RED.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { generateSuggestions } from "../lib/inputAssistance/gateway.js";
import { resolvePolicy, POLICY_VERSION } from "../lib/inputAssistance/policyRegistry.js";
import {
  canonicalizeHashtag,
  checkUsernameAvailability,
} from "../lib/inputAssistance/socialIdentity.js";
import type { InputContext } from "../lib/inputAssistance/types.js";

// ── Stable test UUIDs ──────────────────────────────────────────────────────────

const ME    = "aa000000-0000-4000-a000-000000000001";
const BOB   = "bb000000-0000-4000-a000-000000000002"; // followed, messageable → eligible
const CARL  = "cc000000-0000-4000-a000-000000000003"; // followed BUT blocked → suppressed
const DANA  = "dd000000-0000-4000-a000-000000000004"; // followed BUT message_privacy='no_one'
const EVE   = "ee000000-0000-4000-a000-000000000005"; // private stranger, no relationship
const TAKEN = "ff000000-0000-4000-a000-000000000006"; // owns an existing username

// ── Fake Supabase client (same harness shape as inputAssistanceGateway.test.ts) ─

interface FakeState { [key: string]: any[] | undefined }

function makeFakeClient(state: FakeState, tableErrors: Set<string> = new Set()) {
  const errorBuilder: any = {};
  const errorFns = ["select","eq","neq","in","not","is","ilike","or","gte","lt","order","limit","range","maybeSingle"];
  for (const fn of errorFns) errorBuilder[fn] = () => errorBuilder;
  errorBuilder.then = (onF: any, onR: any) =>
    Promise.resolve({ data: null, error: { message: "simulated DB error" } }).then(onF, onR);

  return {
    from: (table: string) => {
      if (tableErrors.has(table)) return errorBuilder;

      const sourceRows: any[] = [...(state[table] ?? [])];
      const filters: Array<(r: any) => boolean> = [];
      let _rangeStart = 0;
      let _rangeEnd = Infinity;
      let _limitN = Infinity;
      let profileCols: string[] | null = null;
      function project(rowsIn: any[]): any[] {
        if (table !== "profiles" || !profileCols) return rowsIn;
        return rowsIn.map((r) => Object.fromEntries(profileCols!.filter((c) => c in r).map((c) => [c, r[c]])));
      }

      const builder: any = {
        select(cols?: string) {
          if (table === "profiles" && typeof cols === "string" && cols !== "*") {
            profileCols = cols.split(",").map((c) => c.trim());
          }
          return builder;
        },
        eq(col: string, val: any) { filters.push((r) => r[col] === val); return builder; },
        neq(col: string, val: any) { filters.push((r) => r[col] !== val); return builder; },
        in(col: string, vals: any[]) { filters.push((r) => vals.includes(r[col])); return builder; },
        not(col: string, op: string, val: any) {
          if (op === "is") filters.push((r) => r[col] !== val && r[col] != null);
          return builder;
        },
        is(col: string, val: any) {
          filters.push((r) => (val === null ? r[col] == null : r[col] === val));
          return builder;
        },
        ilike(col: string, pat: string) {
          const re = new RegExp("^" + pat.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/%/g, ".*") + "$", "i");
          filters.push((r) => re.test(String(r[col] ?? "")));
          return builder;
        },
        or(expr: string) {
          const parts = expr.split(",").map((p) => {
            const m = p.trim().match(/^(\w+)\.([\w]+)\.(.+)$/);
            if (!m) return null;
            return { col: m[1]!, op: m[2]!.toLowerCase(), val: m[3]! };
          }).filter(Boolean) as { col: string; op: string; val: string }[];
          filters.push((r) =>
            parts.some(({ col, op, val }) => {
              const cellStr = String(r[col] ?? "");
              if (op === "ilike") {
                const re = new RegExp("^" + val.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/%/g, ".*") + "$", "i");
                return re.test(cellStr);
              }
              if (op === "eq") return cellStr === val;
              return false;
            }),
          );
          return builder;
        },
        gte(col: string, val: any) { filters.push((r) => r[col] != null && r[col] >= val); return builder; },
        lt(col: string, val: any) { filters.push((r) => r[col] != null && r[col] < val); return builder; },
        order() { return builder; },
        limit(n: number) { _limitN = n; return builder; },
        range(start: number, end: number) { _rangeStart = start; _rangeEnd = end; return builder; },
        maybeSingle() {
          const matched = project(sourceRows.filter((r) => filters.every((f) => f(r))));
          return Promise.resolve({ data: matched[0] ?? null, error: null });
        },
        then(onF: any, onR: any) {
          const matched = project(sourceRows
            .filter((r) => filters.every((f) => f(r)))
            .slice(_rangeStart, _rangeEnd < Infinity ? _rangeEnd + 1 : _limitN < Infinity ? _limitN : undefined));
          return Promise.resolve({ data: matched, error: null }).then(onF, onR);
        },
      };
      return builder;
    },
  };
}

// ── Row builders ────────────────────────────────────────────────────────────────

function profile(id: string, handle: string, name: string, extra: Record<string, unknown> = {}) {
  return {
    id, handle, username: handle, name, avatar_url: null, is_private: false,
    home_city: null, home_country: null, account_status: "active",
    verified: false, is_official: false, show_profile_picture_publicly: true, ...extra,
  };
}

async function gen(sc: any, context: InputContext, text: string, opts: { userId?: string } = {}) {
  const policy = resolvePolicy(context)!;
  return generateSuggestions(sc, {
    context,
    policy,
    text,
    userId: opts.userId ?? ME,
    limit: policy.maxSuggestions,
    lat: null,
    lng: null,
    city: null,
  });
}

// The relationship graph used by the recipient tests: ME follows BOB, CARL, DANA
// (NOT EVE). CARL is blocked. DANA accepts no messages. EVE is an unrelated
// private account.
function recipientState(extra: FakeState = {}): FakeState {
  return {
    profiles: [
      profile(BOB, "bob_traveler", "Bob"),
      profile(CARL, "carl_hiker", "Carl"),
      profile(DANA, "dana_diver", "Dana"),
      profile(EVE, "eve_secret", "Eve", { is_private: true }),
    ],
    user_follows: [
      { follower_id: ME, following_id: BOB },
      { follower_id: ME, following_id: CARL },
      { follower_id: ME, following_id: DANA },
    ],
    user_friendships: [],
    message_thread_members: [],
    trip_members: [],
    blocks: [{ blocker_id: ME, blocked_id: CARL }],
    user_message_settings: [
      { user_id: DANA, message_privacy: "no_one", allow_message_requests: false, allow_trip_member_messages: true, allow_circle_member_messages: true },
    ],
    circle_memberships: [],
    ...extra,
  };
}

const idsOf = (s: any[]) => new Set(s.map((x) => x.entityId));

// ── 1. Recipient search — positive ──────────────────────────────────────────────

describe("telegraph_recipient — eligible recipient search (§54)", () => {
  it("returns an eligible contact with a resolvable action", async () => {
    const sc = makeFakeClient(recipientState());
    const out = await gen(sc, "telegraph_recipient", "bob");
    const bob = out.find((s) => s.entityId === BOB);
    assert.ok(bob, "an eligible followed contact should appear");
    assert.equal(bob!.entityType, "user");
    assert.equal(bob!.policyVersion, POLICY_VERSION);
    // No dead rows (§13): resolvable via an action / entity id.
    assert.ok(bob!.action != null || bob!.entityId != null, "recipient row must resolve");
    // §42: projection must not leak raw internal fields.
    for (const forbidden of ["avatarUrl", "avatar_url", "accessState", "privacyState", "home_city"]) {
      assert.ok(!(forbidden in (bob as any)), `projection must not expose ${forbidden}`);
    }
  });

  it("zero-character field returns the viewer's eligible contacts (start-a-new-conversation picker)", async () => {
    const sc = makeFakeClient(recipientState());
    const out = await gen(sc, "telegraph_recipient", "");
    assert.ok(out.some((s) => s.entityId === BOB), "zero-char should surface eligible contacts");
  });
});

// ── 2. Block gate — mutation-proof A ─────────────────────────────────────────────

describe("telegraph_recipient — blocked contact suppressed (block gate)", () => {
  // MUTATION-PROOF A: in socialIdentity.resolveRecipientSuggestions, replacing
  //   const pool = [...candidateIds].filter((id) => !blockedSet.has(id));
  // with `.filter(() => true)` makes this test RED — CARL (blocked) leaks in.
  it("a blocked contact never appears even though they are followed", async () => {
    const sc = makeFakeClient(recipientState());
    const out = await gen(sc, "telegraph_recipient", "");
    assert.ok(!idsOf(out).has(CARL), "blocked contact must be suppressed");
    assert.ok(idsOf(out).has(BOB), "the eligible contact still appears (proves the gate is real)");
  });
});

// ── 3. Eligibility filter — mutation-proof B (§47) ───────────────────────────────

describe("telegraph_recipient — non-eligible account not revealed (eligibility filter, §47)", () => {
  // MUTATION-PROOF B: in socialIdentity.resolveRecipientSuggestions, replacing
  //   const eligible = capped.filter((_, i) => verdicts[i].verdict !== 'denied');
  // with `const eligible = capped;` makes this test RED — DANA (accepts no
  // messages) is revealed.
  it("a followed contact who accepts no messages is dropped", async () => {
    const sc = makeFakeClient(recipientState());
    const out = await gen(sc, "telegraph_recipient", "");
    assert.ok(!idsOf(out).has(DANA), "non-eligible (message_privacy=no_one) account must not be revealed");
    assert.ok(idsOf(out).has(BOB), "the eligible contact still appears");
  });

  it("a stranger's private account never enters recipient search (structural enumeration protection)", async () => {
    const sc = makeFakeClient(recipientState());
    // Prefix-enumerate for EVE, a private account the viewer has no edge to.
    const out = await gen(sc, "telegraph_recipient", "eve");
    assert.equal(out.length, 0, "a non-related private account must not be discoverable via recipient prefix search");
  });
});

// ── 4. Fail-closed privacy (§29) ─────────────────────────────────────────────────

describe("telegraph_recipient — fail-closed when block state is unknown (§29)", () => {
  it("suppresses everyone when the blocks table errors", async () => {
    const sc = makeFakeClient(recipientState(), new Set(["blocks"]));
    const out = await gen(sc, "telegraph_recipient", "");
    assert.equal(out.length, 0, "fail-closed: no recipients when block state is unknown");
  });
});

// ── 5. Mentions (@ → user_id) as structured references (§26) ─────────────────────

describe("caption / comment — @mention resolves to a user_id (§26)", () => {
  it("an @mention resolves to a structured reference carrying the real user_id", async () => {
    const sc = makeFakeClient({
      profiles: [profile(BOB, "bob_traveler", "Bob")],
      profile_privacy_settings: [{ user_id: BOB, show_real_name: true, allow_profile_discovery: true }],
      blocks: [], user_privacy_settings: [], user_follows: [], friend_requests: [], user_friendships: [],
    });
    const out = await gen(sc, "comment", "@bob");
    const mention = out.find((s) => s.entityId === BOB);
    assert.ok(mention, "the @mention should resolve to the user");
    assert.equal(mention!.entityType, "user");
    assert.equal(mention!.action?.type, "set_structured_value");
    const value = mention!.action && (mention!.action as any).value;
    assert.equal(value.kind, "mention");
    assert.equal(value.userId, BOB, "mention must carry the resolved user_id (structured, not styled)");
  });

  it("a blocked user is excluded from @mention resolution", async () => {
    const sc = makeFakeClient({
      profiles: [profile(CARL, "carl_hiker", "Carl")],
      profile_privacy_settings: [{ user_id: CARL, show_real_name: true, allow_profile_discovery: true }],
      blocks: [{ blocker_id: ME, blocked_id: CARL }],
      user_privacy_settings: [], user_follows: [], friend_requests: [], user_friendships: [],
    });
    const out = await gen(sc, "comment", "@carl");
    assert.ok(!idsOf(out).has(CARL), "blocked user must not be mentionable via resolution");
  });
});

// ── 6. Hashtags (# → canonical slug) as structured references (§26) ──────────────

describe("hashtag canonicalization (§26)", () => {
  it("canonicalizeHashtag folds case and strips the sigil", () => {
    assert.equal(canonicalizeHashtag("#Food"), "food");
    assert.equal(canonicalizeHashtag("FOOD"), "food");
    assert.equal(canonicalizeHashtag("#DaNang2026"), "danang2026");
    assert.equal(canonicalizeHashtag("#food_truck"), "food"); // stops at non-alphanumeric
    assert.equal(canonicalizeHashtag("#a"), null);            // too short
    assert.equal(canonicalizeHashtag("#"), null);
  });

  it("a #hashtag in a caption resolves to its canonical slug as a structured reference", async () => {
    const sc = makeFakeClient({ hashtags: [] });
    const out = await gen(sc, "caption", "#Food");
    const tag = out.find((s) => s.entityType === "hashtag");
    assert.ok(tag, "the #hashtag should resolve");
    assert.equal(tag!.action?.type, "set_structured_value");
    const value = tag!.action && (tag!.action as any).value;
    assert.equal(value.kind, "hashtag");
    assert.equal(value.slug, "food", "hashtag normalizes to its canonical slug");
    assert.equal(tag!.label, "#food");
  });

  it("surfaces an existing canonical hashtag when one matches", async () => {
    const sc = makeFakeClient({
      hashtags: [{ id: "h1", slug: "foodie", name: "foodie", usage_count: 42, is_blocked: false }],
    });
    const out = await gen(sc, "caption", "#food");
    const existing = out.find((s) => s.entityType === "hashtag" && (s.action as any)?.value?.slug === "foodie");
    assert.ok(existing, "an existing matching hashtag should be surfaced");
  });
});

// ── 7. Username validation (§23) ─────────────────────────────────────────────────

describe("username validation (§23)", () => {
  it("reports an available username through the gateway", async () => {
    const sc = makeFakeClient({
      profiles: [], profile_privacy_settings: [], blocks: [], user_privacy_settings: [],
      user_follows: [], friend_requests: [], user_friendships: [],
    });
    const out = await gen(sc, "username", "newhandle99");
    const v = out.find((s) => s.type === "validation");
    assert.ok(v, "a validation row should be emitted for the username context");
    assert.equal((v!.action as any).value.available, true, "an unused username should be available");
    assert.equal((v!.action as any).value.username, "newhandle99");
  });

  it("reports a taken username as unavailable", async () => {
    const sc = makeFakeClient({
      profiles: [profile(TAKEN, "takenhandle", "Taken")],
      profile_privacy_settings: [], blocks: [], user_privacy_settings: [],
      user_follows: [], friend_requests: [], user_friendships: [],
    });
    const out = await gen(sc, "username", "takenhandle");
    const v = out.find((s) => s.type === "validation");
    assert.ok(v, "a validation row should be emitted");
    assert.equal((v!.action as any).value.available, false, "an existing username must be unavailable");
  });

  it("checkUsernameAvailability enforces reserved-name + normalization rules", async () => {
    const sc = makeFakeClient({ profiles: [] });
    assert.equal((await checkUsernameAvailability(sc, "admin", ME)).available, false); // reserved
    assert.equal((await checkUsernameAvailability(sc, "ab", ME)).available, false);    // too short
    assert.equal((await checkUsernameAvailability(sc, "Good_Name", ME)).available, true); // folds case, valid
  });
});
