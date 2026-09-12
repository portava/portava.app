/**
 * Sensing §12 — the messages row a live reference rides in, EXECUTED on a
 * real database (census-sensing §4): the policies lib/liveReferenceMessages
 * says it is written under, read as the roles they name rather than as text.
 *
 *   public.messages carries msg_insert WITH CHECK (false): an authenticated
 *   ACTIVE member cannot INSERT a message through PostgREST at all — so the
 *   route's service-role write is a necessity the schema imposes, not a
 *   shortcut; the service role writes the card and the members' SELECT policy
 *   serves it to an active member and to nobody else — a stranger reads
 *   nothing, a member who left reads nothing; the predicate the module uses
 *   (present row, left_at IS NULL) agrees with authz.is_active_thread_member
 *   for all three; the stored body parses back as the reference; and 2802's
 *   flag row reads FALSE here.
 *
 * What this suite does NOT claim: that any conversation has shared a
 * reference (the flag is FALSE everywhere), or anything about production's
 * rows. Every property here is a property of the schema and the module.
 *
 * Skips without LOCAL_DB_URL exactly as the other db tests do.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";

import { HAVE_DB, asUser, deleteUser, exec, psql, rows, scalar, seedUser } from "./localDb.ts";
import {
  LIVE_REFERENCE_MSG_SUBTYPE,
  LIVE_REFERENCE_MSG_TYPE,
  buildLiveReference,
  liveReferenceBody,
  parseLiveReference,
  type LiveReference,
} from "../../lib/liveReference.js";
import { MESSAGES_TABLE, THREAD_MEMBERS_TABLE } from "../../lib/liveReferenceMessages.js";
import type { LiveClaimEnvelope } from "../../lib/liveClaimRead.js";

const SKIP = !HAVE_DB;
const NOW = Date.now();
const iso = (offsetMinutes: number) => new Date(NOW + offsetMinutes * 60_000).toISOString();
const PLACE = "88888888-bbbb-4bbb-8bbb-888888888888";

function envelope(): LiveClaimEnvelope {
  return {
    id: "snap-dbsuite-crowd",
    claimType: "crowd.level",
    value: { level: "packed" },
    confidence: 0.85,
    band: "live",
    sourceClass: "firsthand_unverified",
    sourceCountBucket: "many",
    observedAt: iso(-3),
    validUntil: iso(27),
    state: "live",
    conflictState: "none",
    conflict: null,
  };
}

function sql(s: string): string {
  return s.replace(/'/g, "''");
}

describe("2802 / messages — a live reference on a real database", { skip: SKIP }, () => {
  let member = "";
  let leaver = "";
  let stranger = "";
  let threadId = "";
  let reference: LiveReference;
  let messageId = "";

  before(() => {
    member = seedUser("lr_member");
    leaver = seedUser("lr_leaver");
    stranger = seedUser("lr_stranger");
    const built = buildLiveReference({ kind: "experience_state", subject: { id: PLACE, name: "Han Market" }, envelopes: [envelope()], versions: null, nowMs: NOW });
    assert.equal(built.ok, true);
    reference = (built as { ok: true; reference: LiveReference }).reference;
    threadId = scalar(
      `SET LOCAL ROLE service_role;\n` +
        `INSERT INTO public.message_threads (thread_type, created_by) VALUES ('direct', '${member}') RETURNING id;`,
    )!;
    assert.match(threadId, /^[0-9a-f-]{36}$/);
    exec(
      `SET LOCAL ROLE service_role;\n` +
        `INSERT INTO public.${THREAD_MEMBERS_TABLE} (thread_id, user_id) VALUES ('${threadId}', '${member}'), ('${threadId}', '${leaver}');\n` +
        `UPDATE public.${THREAD_MEMBERS_TABLE} SET left_at = now() WHERE thread_id = '${threadId}' AND user_id = '${leaver}';`,
      { single: true },
    );
  });

  after(() => {
    if (threadId) {
      exec(
        `SET LOCAL ROLE service_role;\n` +
          `DELETE FROM public.${MESSAGES_TABLE} WHERE thread_id = '${threadId}';\n` +
          `DELETE FROM public.${THREAD_MEMBERS_TABLE} WHERE thread_id = '${threadId}';\n` +
          `DELETE FROM public.message_threads WHERE id = '${threadId}';`,
        { single: true },
      );
    }
    for (const id of [member, leaver, stranger]) if (id) deleteUser(id);
  });

  it("2802: the flag row is seeded and reads FALSE", () => {
    assert.equal(scalar(`SELECT enabled::text FROM public.feature_flags WHERE flag = 'telegraph_live_references_enabled'`), "false");
  });

  it("msg_insert WITH CHECK (false): an authenticated ACTIVE member cannot INSERT a message at all", () => {
    const policy = scalar(`SELECT with_check FROM pg_policies WHERE tablename = 'messages' AND policyname = 'msg_insert'`);
    assert.equal(policy, "false", "the baseline policy this module's header cites");
    const r = psql(
      [
        `SELECT set_config('request.jwt.claim.sub', '${member}', true);`,
        `SELECT set_config('request.jwt.claim.role', 'authenticated', true);`,
        `SET LOCAL ROLE authenticated;`,
        `INSERT INTO public.${MESSAGES_TABLE} (thread_id, sender_id, body, msg_type, subtype) VALUES ('${threadId}', '${member}', '${sql(liveReferenceBody(reference))}', '${LIVE_REFERENCE_MSG_TYPE}', '${LIVE_REFERENCE_MSG_SUBTYPE}');`,
      ].join("\n"),
      { single: true },
    );
    assert.notEqual(r.status, 0, "the insert must be refused");
    assert.match(r.stderr, /42501|row-level security/i);
    assert.equal(scalar(`SET LOCAL ROLE service_role;\nSELECT count(*)::text FROM public.${MESSAGES_TABLE} WHERE thread_id = '${threadId}'`), "0");
  });

  it("the service role writes the card, RETURNING its id, as the module does", () => {
    messageId = scalar(
      `SET LOCAL ROLE service_role;\n` +
        `INSERT INTO public.${MESSAGES_TABLE} (thread_id, sender_id, body, msg_type, subtype) VALUES ('${threadId}', '${member}', '${sql(liveReferenceBody(reference))}', '${LIVE_REFERENCE_MSG_TYPE}', '${LIVE_REFERENCE_MSG_SUBTYPE}') RETURNING id;`,
    )!;
    assert.match(messageId, /^[0-9a-f-]{36}$/);
    const stored = rows<{ msg_type: string; subtype: string; body: string; deleted_at: string | null }>(
      `SELECT msg_type, subtype, body, deleted_at FROM public.${MESSAGES_TABLE} WHERE id = '${messageId}'`,
    );
    assert.equal(stored.length, 1);
    assert.equal(stored[0]!.msg_type, "card");
    assert.equal(stored[0]!.subtype, "live_reference");
    assert.equal(stored[0]!.deleted_at, null);
    assert.deepEqual(parseLiveReference(stored[0]!.body), reference, "the body the database holds parses back as the reference");
  });

  it("msg_select: the active member reads the card; the stranger and the member who left read nothing", () => {
    const q = `SELECT id FROM public.${MESSAGES_TABLE} WHERE id = '${messageId}';`;
    assert.deepEqual(asUser(member, q), [messageId]);
    assert.deepEqual(asUser(stranger, q), []);
    assert.deepEqual(asUser(leaver, q), []);
  });

  it("the module's membership predicate agrees with authz.is_active_thread_member for all three", () => {
    for (const [uid, expected] of [
      [member, "true"],
      [stranger, "false"],
      [leaver, "false"],
    ] as const) {
      const db = asUser(uid, `SELECT authz.is_active_thread_member('${threadId}')::text;`);
      assert.deepEqual(db, [expected], `is_active_thread_member for ${uid}`);
      // lib/liveReferenceMessages.isActiveThreadMember: a present row with left_at IS NULL.
      const row = rows<{ left_at: string | null }>(
        `SELECT left_at FROM public.${THREAD_MEMBERS_TABLE} WHERE thread_id = '${threadId}' AND user_id = '${uid}'`,
      );
      const moduleSays = row.length === 1 && row[0]!.left_at == null;
      assert.equal(moduleSays, expected === "true", `module predicate for ${uid}`);
    }
  });

  it("msg_update is closed to members too: a member cannot edit the shared reference into different prose", () => {
    const r = psql(
      [
        `SELECT set_config('request.jwt.claim.sub', '${member}', true);`,
        `SELECT set_config('request.jwt.claim.role', 'authenticated', true);`,
        `SET LOCAL ROLE authenticated;`,
        `UPDATE public.${MESSAGES_TABLE} SET body = '{"type":"live_reference","tampered":true}' WHERE id = '${messageId}';`,
      ].join("\n"),
      { single: true },
    );
    // Either the policy refuses the write (42501) or it silently affects no row; both leave the body intact.
    void r;
    const body = scalar(`SET LOCAL ROLE service_role;\nSELECT body FROM public.${MESSAGES_TABLE} WHERE id = '${messageId}'`);
    assert.deepEqual(parseLiveReference(body), reference);
  });
});
