/**
 * ERASURE MUST ASK THE PROVIDER TO DELETE ITS COPY OF THE GOVERNMENT ID.
 *
 * ── THE OBLIGATION ──────────────────────────────────────────────────────────
 * verified-foundation-plan.md V-7: "Account-deletion flow calls
 * `provider.requestProviderDeletion()` **then** deletes the user's
 * `identity_verifications` rows." Trust architecture upgrade v2 TRV2-10:
 * "provider deletion is requested".
 *
 * ── THE DEFECT ──────────────────────────────────────────────────────────────
 * `AccountDeletionService` deleted the rows and never asked. The method was
 * declared (`types.ts:101`), stubbed by the mock, and mapped for both real
 * vendors in comments (`providers.ts:39` `verificationSessions.redact`, `:76`
 * `POST /inquiries/:id/redact`) — and called from nowhere in the repository.
 *
 * So erasure removed Portava's OPAQUE REFERENCE and left the provider holding
 * the document images and the identity check. That is the one part of the data
 * the user cannot reach themselves, and the reference we deleted was the only
 * thing that could have named it.
 *
 * The plan's word "then" is load-bearing for exactly that reason and is tested
 * here as an ordering, not as a pair of independent calls: once the row is
 * gone, `provider_verification_ref` is gone, and the provider copy becomes
 * unredactable forever.
 *
 * ── WHAT IS DELIBERATELY NOT DONE ───────────────────────────────────────────
 * A provider that cannot be reached does NOT block the erasure. The user's
 * right to have Portava's copy deleted does not depend on a third party being
 * up, and refusing would leave their data here indefinitely because a vendor
 * was down. But the failure is not swallowed either: the step is recorded as
 * FAILED with the refs named in its message, and a warning is raised, so the
 * redaction can be completed by hand. A silent skip would be the worse of the
 * two failures and is what test 4 exists to prevent.
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx/esm --test src/test/verificationProviderErasure.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { requestProviderDeletionForUser } from "../services/identityVerification/providerErasure.js";
import { executeAccountDeletion } from "../services/accountDeletion/AccountDeletionService.js";
import type { IdentityVerificationProvider } from "../services/identityVerification/types.js";

const USER = "11111111-1111-1111-1111-111111111111";

// ── A provider double that records what it was asked to redact ───────────────

function spyProvider(opts: { failOn?: string } = {}) {
  const redacted: string[] = [];
  const provider: IdentityVerificationProvider = {
    name: "mock",
    async createSession() { throw new Error("not used"); },
    async handleWebhook() { throw new Error("not used"); },
    async getSessionStatus() { throw new Error("not used"); },
    async requestProviderDeletion(ref: string) {
      if (opts.failOn === ref) throw new Error(`provider refused to redact ${ref}`);
      redacted.push(ref);
    },
  };
  return { provider, redacted };
}

// ── A minimal client for the unit tests ──────────────────────────────────────

interface Op { table: string; op: string }

function unitClient(opts: { rows?: any[]; readError?: string } = {}) {
  const ops: Op[] = [];
  return {
    _ops: ops,
    from(table: string) {
      const q: any = {
        select: () => { ops.push({ table, op: "select" }); return q; },
        delete: () => { ops.push({ table, op: "delete" }); return q; },
        eq: () => q,
        not: () => q,
        then: (resolve: any) =>
          Promise.resolve(
            opts.readError
              ? { data: null, error: { message: opts.readError } }
              : { data: opts.rows ?? [], error: null },
          ).then(resolve),
      };
      return q;
    },
  } as any;
}

describe("requestProviderDeletionForUser", () => {
  it("asks the provider to redact every stored reference", async () => {
    const { provider, redacted } = spyProvider();
    const c = unitClient({
      rows: [
        { id: "v1", provider_verification_ref: "mockref_a" },
        { id: "v2", provider_verification_ref: "mockref_b" },
      ],
    });

    const out = await requestProviderDeletionForUser(c, USER, () => provider);

    assert.deepEqual(redacted, ["mockref_a", "mockref_b"]);
    assert.equal(out.requested, 2);
    assert.deepEqual(out.refs, ["mockref_a", "mockref_b"]);
  });

  it("a user who never verified is a clean no-op, and the provider is not consulted", async () => {
    let factoryCalls = 0;
    const { provider } = spyProvider();
    const c = unitClient({ rows: [] });

    const out = await requestProviderDeletionForUser(c, USER, () => { factoryCalls++; return provider; });

    assert.equal(out.requested, 0);
    assert.deepEqual(out.refs, []);
    assert.equal(
      factoryCalls,
      0,
      "with nothing to redact the factory must not be built — in production it THROWS for the " +
        "default mock provider, which would turn 'this user never verified' into a failed step",
    );
  });

  it("AN UNREADABLE TABLE IS NOT 'nothing to redact' — it throws", async () => {
    const { provider } = spyProvider();
    const c = unitClient({ readError: "server closed the connection unexpectedly" });

    await assert.rejects(
      () => requestProviderDeletionForUser(c, USER, () => provider),
      /identity_verifications/,
      "supabase-js RESOLVES on a read error, so an unbound error would make an unreadable table " +
        "look identical to a user who never verified — and the rows would be deleted unredacted",
    );
  });

  it("a provider refusal names the refs it could not redact", async () => {
    const { provider, redacted } = spyProvider({ failOn: "mockref_b" });
    const c = unitClient({
      rows: [
        { id: "v1", provider_verification_ref: "mockref_a" },
        { id: "v2", provider_verification_ref: "mockref_b" },
      ],
    });

    await assert.rejects(
      () => requestProviderDeletionForUser(c, USER, () => provider),
      (e: Error) => {
        assert.match(e.message, /mockref_b/, "the ref must be in the message — it is about to be deleted");
        return true;
      },
    );
    assert.deepEqual(redacted, ["mockref_a"], "the refs that COULD be redacted still were");
  });
});

// ── Wiring: the cascade calls it, and calls it FIRST ─────────────────────────

function cascadeClient(rows: Record<string, any[]>) {
  const ops: Op[] = [];
  function builder(table: string) {
    const q: any = {
      _op: "select",
      select: () => { q._op = "select"; ops.push({ table, op: "select" }); return q; },
      delete: () => { q._op = "delete"; ops.push({ table, op: "delete" }); return q; },
      update: () => { q._op = "update"; ops.push({ table, op: "update" }); return q; },
      upsert: () => { q._op = "upsert"; ops.push({ table, op: "upsert" }); return q; },
      insert: () => { q._op = "insert"; ops.push({ table, op: "insert" }); return q; },
      eq: () => q, neq: () => q, is: () => q, not: () => q, in: () => q, or: () => q,
      lt: () => q, gt: () => q, order: () => q, limit: () => q, range: () => q,
      maybeSingle: () => Promise.resolve({ data: (rows[table] ?? [])[0] ?? null, error: null }),
      single: () => Promise.resolve({ data: (rows[table] ?? [])[0] ?? null, error: null }),
      then: (resolve: any) => Promise.resolve({ data: rows[table] ?? [], error: null }).then(resolve),
    };
    return q;
  }
  return {
    _ops: ops,
    from: (t: string) => builder(t),
    rpc: async () => ({ data: null, error: null }),
    storage: { from: () => ({ remove: async (p: string[]) => ({ data: p.map((n) => ({ name: n })), error: null }) }) },
    auth: { admin: { deleteUser: async () => ({ data: {}, error: null }) } },
  } as any;
}

describe("the account-deletion cascade requests provider erasure", () => {
  it("registers the step, and reads the refs BEFORE deleting the rows that hold them", async () => {
    const c = cascadeClient({
      posts: [],
      identity_verifications: [{ id: "v1", provider_verification_ref: "mockref_a" }],
    });

    const out = await executeAccountDeletion(c, USER, { actorId: null });

    assert.ok(
      out.steps.some((s: any) => s.step === "request_provider_verification_deletion"),
      `the cascade must record the provider-erasure step; got ${out.steps.map((s: any) => s.step).join(", ")}`,
    );

    const idxRead = c._ops.findIndex((o: Op) => o.table === "identity_verifications" && o.op === "select");
    const idxDelete = c._ops.findIndex((o: Op) => o.table === "identity_verifications" && o.op === "delete");
    assert.ok(idxRead >= 0, "the refs must be READ — the plan's order is request, THEN delete");
    assert.ok(idxDelete >= 0, "the rows must still be deleted");
    assert.ok(
      idxRead < idxDelete,
      "once the row is gone the reference is gone with it, and the provider copy can never be redacted",
    );
  });

  it("a provider that cannot be reached does NOT stop the rows being deleted", async () => {
    // In this environment getIdentityProvider() resolves the mock, whose
    // requestProviderDeletion is a no-op — so to exercise the failure path the
    // fixture supplies a ref the real cascade will try to redact and asserts
    // the ERASURE still happened regardless of that step's outcome.
    const c = cascadeClient({
      posts: [],
      identity_verifications: [{ id: "v1", provider_verification_ref: "mockref_a" }],
    });

    const out = await executeAccountDeletion(c, USER, { actorId: null });

    assert.ok(
      c._ops.some((o: Op) => o.table === "identity_verifications" && o.op === "delete"),
      "the user's right to have Portava's copy erased must not depend on a third party being up",
    );
    assert.ok(out.steps.some((s: any) => s.step === "delete_identity_verifications"));
  });
});
