import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { guardUploadRequest } from "../lib/mediaPipeline.js";

function fixture(userId: string, initial: unknown) {
  let reply = initial;
  let reads = 0;
  const sc = {
    from() {
      const query = { select: () => query, eq: () => query,
        maybeSingle: async () => ({ data: { enabled: false }, error: null }) };
      return query;
    },
    async rpc(name: string, args: { p_user: string }) {
      assert.equal(name, "account_recovery_status"); assert.equal(args.p_user, userId); reads++;
      if (reply instanceof Error) throw reply;
      return reply;
    },
  };
  return { sc, set: (next: unknown) => { reply = next; }, reads: () => reads };
}

for (const [name, data] of Object.entries({
  deactivated: { accountStatus: "deactivated", mediaAccessAllowed: false },
  deleted: { accountStatus: "deleted", mediaAccessAllowed: false },
  pendingOrIrreversibleDeletion: { accountStatus: "active", mediaAccessAllowed: false },
  incomplete: { accountStatus: "active" },
  missing: null,
})) {
  test(`upload guard refuses ${name} account authority`, async () => {
    const userId = randomUUID();
    const f = fixture(userId, { data: data && { userId, ...data }, error: null });
    assert.deepEqual(await guardUploadRequest(f.sc, userId), { ok: false,
      failure: { code: "forbidden", message: "An active account is required to upload media." } });
    assert.equal(f.reads(), 1);
  });
}

test("upload guard refuses missing, failed, mismatched and malformed account snapshots", async () => {
  const userId = randomUUID(); const active = { userId, accountStatus: "active", mediaAccessAllowed: true };
  for (const reply of [null, undefined, new Error("unavailable"), { data: active },
    { data: active, error: { code: "PGRST202" } },
    { data: { ...active, userId: randomUUID() }, error: null }]) {
    assert.equal((await guardUploadRequest(fixture(userId, reply).sc, userId)).ok, false);
  }
});

test("upload authority is reread: deactivation denies and explicit recovery permits again", async () => {
  const userId = randomUUID(); const active = { data: { userId, accountStatus: "active", mediaAccessAllowed: true }, error: null };
  const f = fixture(userId, active);
  assert.equal((await guardUploadRequest(f.sc, userId)).ok, true);
  f.set({ data: { ...active.data, mediaAccessAllowed: false }, error: null });
  assert.equal((await guardUploadRequest(f.sc, userId)).ok, false);
  f.set(active);
  assert.equal((await guardUploadRequest(f.sc, userId)).ok, true);
  assert.equal(f.reads(), 3);
});
